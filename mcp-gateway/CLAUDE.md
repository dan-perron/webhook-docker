# CLAUDE.md

MCP gateway: one remote MCP endpoint, `https://djperron.com/mcp`, that merges
the tools of the stack's apps (bet-tracker, recipes, …) behind one OAuth
login, so claude.ai needs a single connector. Hono, Node 24, Mongo database
`mcp`, port 3005, served at `/mcp` in the webhook-docker stack.

## Development

No native modules; runs on the host's Node 24.

```bash
yarn install
yarn test          # vitest; starts an in-memory mongod (mongodb-memory-server)
yarn typecheck
yarn lint:check && yarn format:check
```

## How it works

- `MCP_BACKENDS` (`name=url,...`) lists each app's own stateless MCP endpoint
  on the stack network; `MCP_TOKEN_<NAME>` is the bearer token that app's
  `/mcp` accepts. Backends are plain MCP servers and know nothing about the
  gateway.
- `BackendPool` (`src/mcp/backends.ts`) is an MCP client. Discovery
  (initialize + `tools/list` per backend, in parallel) is cached 60 s and
  supplies the merged tool list and instructions (`## <backend>` sections).
  Tool names pass through unprefixed; on a clash the first backend in
  `MCP_BACKENDS` wins and the clash is logged. An unreachable backend is left
  out of that round (`/mcp/healthz` lists why). `tools/call` goes to the
  owning backend; an unknown name forces one re-discovery first.
- `createGatewayServer` (`src/mcp/gateway.ts`) is a low-level SDK `Server`
  built per request (stateless, JSON responses), after discovery so
  `initialize` carries the merged instructions.
- Adding an app: give it a stateless `/mcp` behind a bearer token (copy
  bet-tracker's `r.all('/mcp', ...)`), add `name=url` to `MCP_BACKENDS` and its
  `MCP_TOKEN_<NAME>` line in `docker-compose.yml`. Pick tool names that cannot
  clash with other apps.

## OAuth

`src/auth/` (moved from bet-tracker). Single user: dynamic client
registration, PKCE S256, consent password = `MCP_APP_TOKEN`, redirect
allowlist = Claude's connector callbacks + loopback (+
`OAUTH_EXTRA_REDIRECT_URIS`). Codes 5 min, access 1 h, refresh 30 d with
rotation; all stored hashed. Mongo is standalone (no transactions), so codes
and refresh tokens are claimed with one conditional `findOneAndUpdate`; a
replayed code revokes the client's tokens. TTL indexes purge rows a day after
they expire. `Authorization: Bearer <MCP_APP_TOKEN>` also works (Claude Code,
scripts).

## Deploy (Apache on signs)

Add to `/etc/apache2/sites-enabled/000-default-le-ssl.conf` next to /bets. The
two `.well-known` lines serve the metadata at the root paths RFC 8414/9728
derive from `https://djperron.com/mcp`; they must come before the `/mcp` pair.

    ProxyPass        "/.well-known/oauth-protected-resource/mcp" "http://localhost:3005/mcp/.well-known/oauth-protected-resource"
    ProxyPass        "/.well-known/oauth-authorization-server/mcp" "http://localhost:3005/mcp/.well-known/oauth-authorization-server"
    ProxyPass        "/mcp" "http://localhost:3005/mcp" timeout=300
    ProxyPassReverse "/mcp" "http://localhost:3005/mcp"

Then `sudo apachectl configtest && sudo systemctl reload apache2`, add the
connector `https://djperron.com/mcp` in claude.ai, and remove the old bets one.
