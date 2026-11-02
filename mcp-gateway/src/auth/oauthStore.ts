import type { Collection, Db } from 'mongodb';
import { pkceMatches, randomToken, sha256 } from './secrets.js';

// Single-user OAuth 2.1 authorization server state: public clients (PKCE),
// one-time codes, and hashed access/refresh tokens with refresh rotation.
// Mongo here is standalone (no transactions), so every one-time use is a
// single conditional findOneAndUpdate.

export const CODE_TTL_SECONDS = 5 * 60;
export const ACCESS_TTL_SECONDS = 60 * 60;
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
// Expired rows are purged this long after they expire (Mongo TTL index), so
// a replayed code is still recognized for a while.
const PURGE_AFTER_SECONDS = 24 * 60 * 60;

/** Claude's hosted connector callbacks; loopback URIs are always allowed. */
export const DEFAULT_REDIRECT_ALLOWLIST = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];

export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400
  ) {
    super(description);
  }
}

/** Exact allowlisted URI, or an http loopback URI (Claude Code/Desktop). */
export function isAllowedRedirect(uri: string, allowlist: string[]): boolean {
  if (allowlist.includes(uri)) return true;
  try {
    const u = new URL(uri);
    return (
      u.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope?: string;
}

interface ClientDoc {
  _id: string;
  clientName: string | null;
  redirectUris: string[];
  createdAt: Date;
}
interface CodeDoc {
  _id: string; // sha256(code)
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string | null;
  expiresAt: Date;
  usedAt: Date | null;
}
interface TokenDoc {
  _id: string; // sha256(token)
  kind: 'access' | 'refresh';
  clientId: string;
  scope: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
}

export class OAuthStore {
  private readonly clients: Collection<ClientDoc>;
  private readonly codes: Collection<CodeDoc>;
  private readonly tokens: Collection<TokenDoc>;

  constructor(
    db: Db,
    private readonly opts: { redirectAllowlist: string[]; now?: () => Date }
  ) {
    this.clients = db.collection('oauth_clients');
    this.codes = db.collection('oauth_codes');
    this.tokens = db.collection('oauth_tokens');
  }

  async ensureIndexes() {
    await Promise.all([
      this.codes.createIndex(
        { expiresAt: 1 },
        { expireAfterSeconds: PURGE_AFTER_SECONDS }
      ),
      this.tokens.createIndex(
        { expiresAt: 1 },
        { expireAfterSeconds: PURGE_AFTER_SECONDS }
      ),
      this.tokens.createIndex({ clientId: 1 }),
    ]);
  }

  private now() {
    return (this.opts.now ?? (() => new Date()))();
  }

  private at(seconds: number) {
    return new Date(this.now().getTime() + seconds * 1000);
  }

  /** RFC 7591 dynamic registration for a public client. */
  async registerClient(body: {
    client_name?: unknown;
    redirect_uris?: unknown;
  }) {
    const uris = body.redirect_uris;
    if (
      !Array.isArray(uris) ||
      uris.length === 0 ||
      !uris.every((u) => typeof u === 'string')
    ) {
      throw new OAuthError(
        'invalid_redirect_uri',
        'redirect_uris must be a non-empty array of strings'
      );
    }
    const bad = uris.filter(
      (u) => !isAllowedRedirect(u, this.opts.redirectAllowlist)
    );
    if (bad.length) {
      throw new OAuthError(
        'invalid_redirect_uri',
        `redirect_uri not allowed: ${bad.join(', ')}`
      );
    }
    const clientName =
      typeof body.client_name === 'string'
        ? body.client_name.slice(0, 100)
        : null;
    const clientId = randomToken();
    await this.clients.insertOne({
      _id: clientId,
      clientName,
      redirectUris: uris,
      createdAt: this.now(),
    });
    return {
      client_id: clientId,
      client_name: clientName ?? undefined,
      redirect_uris: uris as string[],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      client_id_issued_at: Math.floor(this.now().getTime() / 1000),
    };
  }

  async getClient(clientId: string) {
    const c = await this.clients.findOne({ _id: clientId });
    return c ? { ...c, clientId: c._id } : undefined;
  }

  /** Validate an authorization request; throws OAuthError if unusable. */
  async checkAuthorizeRequest(p: {
    client_id?: string;
    redirect_uri?: string;
    response_type?: string;
    code_challenge?: string;
    code_challenge_method?: string;
  }) {
    const client = p.client_id ? await this.getClient(p.client_id) : undefined;
    if (!client) throw new OAuthError('invalid_client', 'Unknown client');
    if (!p.redirect_uri || !client.redirectUris.includes(p.redirect_uri)) {
      throw new OAuthError(
        'invalid_request',
        'redirect_uri is not registered for this client'
      );
    }
    if (p.response_type !== 'code') {
      throw new OAuthError(
        'unsupported_response_type',
        'response_type must be code'
      );
    }
    if (!p.code_challenge || p.code_challenge_method !== 'S256') {
      throw new OAuthError(
        'invalid_request',
        'PKCE with code_challenge_method S256 is required'
      );
    }
    return client;
  }

  async createCode(p: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scope?: string | null;
  }): Promise<string> {
    const code = randomToken();
    await this.codes.insertOne({
      _id: sha256(code),
      clientId: p.clientId,
      redirectUri: p.redirectUri,
      codeChallenge: p.codeChallenge,
      scope: p.scope ?? null,
      expiresAt: this.at(CODE_TTL_SECONDS),
      usedAt: null,
    });
    return code;
  }

  private async issueTokens(
    clientId: string,
    scope: string | null
  ): Promise<TokenResponse> {
    const access = randomToken();
    const refresh = randomToken();
    await this.tokens.insertMany([
      {
        _id: sha256(access),
        kind: 'access',
        clientId,
        scope,
        expiresAt: this.at(ACCESS_TTL_SECONDS),
        revokedAt: null,
      },
      {
        _id: sha256(refresh),
        kind: 'refresh',
        clientId,
        scope,
        expiresAt: this.at(REFRESH_TTL_SECONDS),
        revokedAt: null,
      },
    ]);
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_SECONDS,
      refresh_token: refresh,
      ...(scope ? { scope } : {}),
    };
  }

  async exchangeCode(p: {
    code?: string;
    clientId?: string;
    redirectUri?: string;
    verifier?: string;
  }): Promise<TokenResponse> {
    if (!p.code || !p.clientId || !p.redirectUri || !p.verifier) {
      throw new OAuthError(
        'invalid_request',
        'code, client_id, redirect_uri and code_verifier are required'
      );
    }
    const invalid = new OAuthError(
      'invalid_grant',
      'Code is invalid, expired or already used'
    );
    const hash = sha256(p.code);
    const now = this.now();
    const row = await this.codes.findOne({ _id: hash });
    if (!row || row.usedAt || row.expiresAt <= now) {
      // A replayed code revokes everything issued to that client.
      if (row?.usedAt) await this.revokeClient(row.clientId, now);
      throw invalid;
    }
    if (row.clientId !== p.clientId || row.redirectUri !== p.redirectUri) {
      throw new OAuthError(
        'invalid_grant',
        'Code was issued to a different client or redirect_uri'
      );
    }
    if (!pkceMatches(p.verifier, row.codeChallenge)) {
      throw new OAuthError('invalid_grant', 'PKCE verification failed');
    }
    // Claim the code; a concurrent exchange that lost the race is a replay.
    const claimed = await this.codes.findOneAndUpdate(
      { _id: hash, usedAt: null },
      { $set: { usedAt: now } }
    );
    if (!claimed) {
      await this.revokeClient(row.clientId, now);
      throw invalid;
    }
    return this.issueTokens(row.clientId, row.scope);
  }

  private async revokeClient(clientId: string, now: Date) {
    await this.tokens.updateMany(
      { clientId, revokedAt: null },
      { $set: { revokedAt: now } }
    );
  }

  /** Rotate: the presented refresh token is revoked and a new pair issued. */
  async refresh(p: {
    refreshToken?: string;
    clientId?: string;
  }): Promise<TokenResponse> {
    if (!p.refreshToken || !p.clientId) {
      throw new OAuthError(
        'invalid_request',
        'refresh_token and client_id are required'
      );
    }
    const now = this.now();
    const row = await this.tokens.findOneAndUpdate(
      {
        _id: sha256(p.refreshToken),
        kind: 'refresh',
        clientId: p.clientId,
        revokedAt: null,
        expiresAt: { $gt: now },
      },
      { $set: { revokedAt: now } }
    );
    if (!row) {
      throw new OAuthError(
        'invalid_grant',
        'Refresh token is invalid, expired or revoked'
      );
    }
    return this.issueTokens(row.clientId, row.scope);
  }

  /** True for a live (unexpired, unrevoked) access token. */
  async verifyAccessToken(token: string): Promise<boolean> {
    return !!(await this.tokens.findOne(
      {
        _id: sha256(token),
        kind: 'access',
        revokedAt: null,
        expiresAt: { $gt: this.now() },
      },
      { projection: { _id: 1 } }
    ));
  }
}
