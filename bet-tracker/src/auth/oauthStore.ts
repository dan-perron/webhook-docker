import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { oauthClients, oauthCodes, oauthTokens } from '../db/schema.js';
import { pkceMatches, randomToken, sha256 } from './secrets.js';

// Single-user OAuth 2.1 authorization server state: public clients (PKCE),
// one-time codes, and hashed access/refresh tokens with refresh rotation.

export const CODE_TTL_SECONDS = 5 * 60;
export const ACCESS_TTL_SECONDS = 60 * 60;
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

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

export class OAuthStore {
  constructor(
    private readonly db: Db,
    private readonly opts: { redirectAllowlist: string[]; now?: () => Date }
  ) {}

  private now() {
    return (this.opts.now ?? (() => new Date()))();
  }

  private at(seconds: number) {
    return new Date(this.now().getTime() + seconds * 1000).toISOString();
  }

  /** RFC 7591 dynamic registration for a public client. */
  registerClient(body: { client_name?: unknown; redirect_uris?: unknown }) {
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
    this.db
      .insert(oauthClients)
      .values({ clientId, clientName, redirectUrisJson: JSON.stringify(uris) })
      .run();
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

  getClient(clientId: string) {
    const c = this.db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, clientId))
      .get();
    return c
      ? { ...c, redirectUris: JSON.parse(c.redirectUrisJson) as string[] }
      : undefined;
  }

  /** Validate an authorization request; throws OAuthError if unusable. */
  checkAuthorizeRequest(p: {
    client_id?: string;
    redirect_uri?: string;
    response_type?: string;
    code_challenge?: string;
    code_challenge_method?: string;
  }) {
    const client = p.client_id ? this.getClient(p.client_id) : undefined;
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

  createCode(p: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scope?: string | null;
  }): string {
    const code = randomToken();
    this.db
      .insert(oauthCodes)
      .values({
        codeHash: sha256(code),
        clientId: p.clientId,
        redirectUri: p.redirectUri,
        codeChallenge: p.codeChallenge,
        scope: p.scope ?? null,
        expiresAt: this.at(CODE_TTL_SECONDS),
      })
      .run();
    return code;
  }

  private issueTokens(clientId: string, scope: string | null): TokenResponse {
    const access = randomToken();
    const refresh = randomToken();
    this.db
      .insert(oauthTokens)
      .values([
        {
          tokenHash: sha256(access),
          kind: 'access',
          clientId,
          scope,
          expiresAt: this.at(ACCESS_TTL_SECONDS),
        },
        {
          tokenHash: sha256(refresh),
          kind: 'refresh',
          clientId,
          scope,
          expiresAt: this.at(REFRESH_TTL_SECONDS),
        },
      ])
      .run();
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_SECONDS,
      refresh_token: refresh,
      ...(scope ? { scope } : {}),
    };
  }

  exchangeCode(p: {
    code?: string;
    clientId?: string;
    redirectUri?: string;
    verifier?: string;
  }): TokenResponse {
    if (!p.code || !p.clientId || !p.redirectUri || !p.verifier) {
      throw new OAuthError(
        'invalid_request',
        'code, client_id, redirect_uri and code_verifier are required'
      );
    }
    // Errors are returned, not thrown, inside the transaction so the replay
    // revocation below commits.
    const result = this.db.transaction((tx): TokenResponse | OAuthError => {
      const row = tx
        .select()
        .from(oauthCodes)
        .where(eq(oauthCodes.codeHash, sha256(p.code!)))
        .get();
      const nowIso = this.now().toISOString();
      if (!row || row.usedAt || row.expiresAt <= nowIso) {
        // A replayed code revokes everything issued to that client.
        if (row?.usedAt) {
          tx.update(oauthTokens)
            .set({ revokedAt: nowIso })
            .where(eq(oauthTokens.clientId, row.clientId))
            .run();
        }
        return new OAuthError(
          'invalid_grant',
          'Code is invalid, expired or already used'
        );
      }
      if (row.clientId !== p.clientId || row.redirectUri !== p.redirectUri) {
        return new OAuthError(
          'invalid_grant',
          'Code was issued to a different client or redirect_uri'
        );
      }
      if (!pkceMatches(p.verifier!, row.codeChallenge)) {
        return new OAuthError('invalid_grant', 'PKCE verification failed');
      }
      tx.update(oauthCodes)
        .set({ usedAt: nowIso })
        .where(eq(oauthCodes.codeHash, row.codeHash))
        .run();
      return this.issueTokens(row.clientId, row.scope);
    });
    if (result instanceof OAuthError) throw result;
    return result;
  }

  /** Rotate: the presented refresh token is revoked and a new pair issued. */
  refresh(p: { refreshToken?: string; clientId?: string }): TokenResponse {
    if (!p.refreshToken || !p.clientId) {
      throw new OAuthError(
        'invalid_request',
        'refresh_token and client_id are required'
      );
    }
    return this.db.transaction((tx) => {
      const nowIso = this.now().toISOString();
      const row = tx
        .select()
        .from(oauthTokens)
        .where(
          and(
            eq(oauthTokens.tokenHash, sha256(p.refreshToken!)),
            eq(oauthTokens.kind, 'refresh')
          )
        )
        .get();
      if (
        !row ||
        row.revokedAt ||
        row.expiresAt <= nowIso ||
        row.clientId !== p.clientId
      ) {
        throw new OAuthError(
          'invalid_grant',
          'Refresh token is invalid, expired or revoked'
        );
      }
      tx.update(oauthTokens)
        .set({ revokedAt: nowIso })
        .where(eq(oauthTokens.tokenHash, row.tokenHash))
        .run();
      return this.issueTokens(row.clientId, row.scope);
    });
  }

  /** True for a live (unexpired, unrevoked) access token. */
  verifyAccessToken(token: string): boolean {
    const nowIso = this.now().toISOString();
    return !!this.db
      .select({ h: oauthTokens.tokenHash })
      .from(oauthTokens)
      .where(
        and(
          eq(oauthTokens.tokenHash, sha256(token)),
          eq(oauthTokens.kind, 'access'),
          isNull(oauthTokens.revokedAt),
          gt(oauthTokens.expiresAt, nowIso)
        )
      )
      .get();
  }
}
