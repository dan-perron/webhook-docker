import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { url } from '../util/url.js';
import { OAuthError, type OAuthStore } from './oauthStore.js';
import type { FailureLimiter } from './rateLimit.js';
import { safeEqual } from './secrets.js';

// OAuth 2.1 endpoints for remote MCP clients (claude.ai web/mobile, Claude
// Desktop/Code). One user: the "login" is APP_TOKEN. The app is served under
// a base path, so clients find metadata via the WWW-Authenticate header on
// 401s and the path-scoped well-known URLs below; the README has the Apache
// lines for the root-level well-known paths.

export interface OAuthConfig {
  /** e.g. https://djperron.com/bets */
  issuer: string;
  appToken: string;
  store: OAuthStore;
  limiter: FailureLimiter;
}

const SCOPE = 'bets';

export const resourceUrl = (issuer: string) => `${issuer}/mcp`;
export const resourceMetadataUrl = (issuer: string) =>
  `${issuer}/.well-known/oauth-protected-resource`;

/** Best-effort client address behind Apache. */
export function clientKey(c: Context): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'direct';
}

function oauthError(c: Context, e: unknown) {
  if (e instanceof OAuthError) {
    return c.json(
      { error: e.error, error_description: e.description },
      e.status as 400
    );
  }
  throw e;
}

function Page(props: { title: string; children: unknown }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        <style>{`
          :root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --fg:#14171a; --muted:#5b6670; --accent:#1f6feb; --bad:#c62828; }
          @media (prefers-color-scheme: dark) { :root { --bg:#0e1116; --card:#171b22; --fg:#e6e9ee; --muted:#9aa4af; --accent:#4c8dff; --bad:#ff6b6b; } }
          body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.45 system-ui, sans-serif; }
          main { max-width:420px; margin:0 auto; padding:32px 16px; }
          .card { background:var(--card); border-radius:12px; padding:20px; box-shadow:0 1px 3px rgba(0,0,0,.12); }
          h1 { font-size:20px; margin:0 0 8px; } p { color:var(--muted); margin:0 0 16px; }
          input { width:100%; box-sizing:border-box; padding:12px; font-size:16px; border-radius:8px; border:1px solid var(--muted); background:transparent; color:var(--fg); }
          .row { display:flex; gap:8px; margin-top:12px; }
          button { flex:1; padding:12px; font-size:16px; border-radius:8px; border:0; background:var(--accent); color:#fff; }
          button.secondary { background:transparent; color:var(--fg); border:1px solid var(--muted); }
          .err { color:var(--bad); margin-bottom:12px; }
        `}</style>
      </head>
      <body>
        <main>
          <section class="card">{props.children}</section>
        </main>
      </body>
    </html>
  );
}

const AUTHORIZE_FIELDS = [
  'client_id',
  'redirect_uri',
  'response_type',
  'code_challenge',
  'code_challenge_method',
  'state',
  'scope',
  'resource',
] as const;
type AuthorizeParams = Partial<
  Record<(typeof AUTHORIZE_FIELDS)[number], string>
>;

function ConsentPage(props: {
  params: AuthorizeParams;
  clientName: string;
  error?: string;
}) {
  return (
    <Page title="Authorize — Bet Tracker">
      <h1>Connect {props.clientName}</h1>
      <p>
        Allow {props.clientName} to read and manage your tracked bets and check
        odds.
      </p>
      {props.error ? <div class="err">{props.error}</div> : null}
      <form method="post" action={url('/oauth/authorize')}>
        {AUTHORIZE_FIELDS.map((k) =>
          props.params[k] != null ? (
            <input type="hidden" name={k} value={props.params[k]} />
          ) : null
        )}
        <input
          name="app_token"
          type="password"
          placeholder="App token"
          autocomplete="current-password"
          autofocus
        />
        <div class="row">
          <button class="secondary" type="submit" name="decision" value="deny">
            Deny
          </button>
          <button type="submit" name="decision" value="allow">
            Allow
          </button>
        </div>
      </form>
    </Page>
  );
}

function redirectWith(
  redirectUri: string,
  params: Record<string, string | undefined>
) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params))
    if (v != null) u.searchParams.set(k, v);
  return u.toString();
}

export function oauthRoutes(cfg: OAuthConfig): Hono {
  const r = new Hono();
  const { issuer, store, limiter } = cfg;

  // Metadata and token/registration endpoints are called cross-origin by
  // browser-based clients; they carry no cookies or ambient authority.
  const open = cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'] });

  const protectedResource = {
    resource: resourceUrl(issuer),
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: [SCOPE],
    resource_name: 'Bet Tracker',
  };
  const serverMetadata = {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE],
  };

  for (const p of [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
  ]) {
    r.use(p, open);
    r.get(p, (c) => c.json(protectedResource));
  }
  for (const p of [
    '/.well-known/oauth-authorization-server',
    '/.well-known/openid-configuration',
  ]) {
    r.use(p, open);
    r.get(p, (c) => c.json(serverMetadata));
  }

  r.use('/oauth/register', open);
  r.post('/oauth/register', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      return c.json(store.registerClient(body), 201);
    } catch (e) {
      return oauthError(c, e);
    }
  });

  r.get('/oauth/authorize', (c) => {
    const params = Object.fromEntries(
      AUTHORIZE_FIELDS.map((k) => [k, c.req.query(k)])
    ) as AuthorizeParams;
    try {
      const client = store.checkAuthorizeRequest(params);
      return c.html(
        <ConsentPage
          params={params}
          clientName={client.clientName ?? 'this app'}
        />
      );
    } catch (e) {
      // Never redirect to an unverified redirect_uri: show the error here.
      const msg = e instanceof OAuthError ? e.description : 'Invalid request';
      return c.html(
        <Page title="Authorization error">
          <h1>Can't connect</h1>
          <p>{msg}</p>
        </Page>,
        400
      );
    }
  });

  r.post('/oauth/authorize', async (c) => {
    const form = await c.req.parseBody();
    const params = Object.fromEntries(
      AUTHORIZE_FIELDS.map((k) => [
        k,
        typeof form[k] === 'string' ? (form[k] as string) : undefined,
      ])
    ) as AuthorizeParams;
    let client;
    try {
      client = store.checkAuthorizeRequest(params);
    } catch (e) {
      return oauthError(c, e);
    }
    const name = client.clientName ?? 'this app';
    if (form.decision === 'deny') {
      return c.redirect(
        redirectWith(params.redirect_uri!, {
          error: 'access_denied',
          state: params.state,
        })
      );
    }
    const key = clientKey(c);
    if (limiter.blocked(key)) {
      return c.html(
        <ConsentPage
          params={params}
          clientName={name}
          error="Too many attempts. Try again later."
        />,
        429
      );
    }
    if (
      typeof form.app_token !== 'string' ||
      !safeEqual(form.app_token, cfg.appToken)
    ) {
      limiter.fail(key);
      return c.html(
        <ConsentPage
          params={params}
          clientName={name}
          error="Wrong app token."
        />,
        401
      );
    }
    limiter.reset(key);
    const code = store.createCode({
      clientId: client.clientId,
      redirectUri: params.redirect_uri!,
      codeChallenge: params.code_challenge!,
      scope: params.scope ?? SCOPE,
    });
    return c.redirect(
      redirectWith(params.redirect_uri!, {
        code,
        state: params.state,
        iss: issuer,
      })
    );
  });

  r.use('/oauth/token', open);
  r.post('/oauth/token', async (c) => {
    const form = await c.req.parseBody();
    const str = (k: string) =>
      typeof form[k] === 'string' ? (form[k] as string) : undefined;
    c.header('Cache-Control', 'no-store');
    try {
      switch (str('grant_type')) {
        case 'authorization_code':
          return c.json(
            store.exchangeCode({
              code: str('code'),
              clientId: str('client_id'),
              redirectUri: str('redirect_uri'),
              verifier: str('code_verifier'),
            })
          );
        case 'refresh_token':
          return c.json(
            store.refresh({
              refreshToken: str('refresh_token'),
              clientId: str('client_id'),
            })
          );
        default:
          throw new OAuthError(
            'unsupported_grant_type',
            'grant_type must be authorization_code or refresh_token'
          );
      }
    } catch (e) {
      return oauthError(c, e);
    }
  });

  return r;
}

/**
 * Accept `Authorization: Bearer <APP_TOKEN>` (Claude Code, scripts) or an
 * OAuth access token (claude.ai connectors). 401s point clients at the
 * protected-resource metadata so they can start OAuth.
 */
export function requireBearer(cfg: OAuthConfig): MiddlewareHandler {
  return async (c, next) => {
    const m = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i);
    const token = m?.[1]?.trim();
    if (
      token &&
      (safeEqual(token, cfg.appToken) || cfg.store.verifyAccessToken(token))
    ) {
      return next();
    }
    c.header(
      'WWW-Authenticate',
      `Bearer resource_metadata="${resourceMetadataUrl(cfg.issuer)}"${token ? ', error="invalid_token"' : ''}`
    );
    return c.json({ error: token ? 'invalid_token' : 'unauthorized' }, 401);
  };
}
