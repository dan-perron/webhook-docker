# CLAUDE.md

Recipe Box: the family's recipes, each member's 1-5 star rating, a log of
when each recipe was made, and "what should we cook?" recommendations. Mainly
fed through MCP (via mcp-gateway); a mobile web page for browsing, rating,
importing from a link and the cook log. Hono + hono/jsx + HTMX, Node 24,
Mongo database `recipes`, port 3004, served at `/recipes`.

## Development

No native modules; runs on the host's Node 24.

```bash
yarn install
yarn test          # vitest; in-memory mongod (mongodb-memory-server)
yarn typecheck
yarn lint:check && yarn format:check
```

## Conventions

- `src/domain/recipeInput.ts` is the single validated recipe shape for MCP,
  the web form and URL import. Blank optional text is dropped; tags are
  lowercase and unique (`normalizeTags`).
- Ids are slugs: recipes from the title (`-2` on collision), members from
  the name. Ids never change on rename/edit, so links and ratings hold.
  Tools accept an id or an exact title/name (accent/case-insensitive) and
  list close matches otherwise.
- Duplicates: `sourceKey` (normalized sourceUrl: no scheme/www/tracking/
  fragment) is unique; the same title is refused unless
  `allowDuplicateTitle`.
- Ratings: one per (recipe, member), `_id = recipeId:memberId`; rating again
  replaces. Web: tapping your current star clears it.
- Mongo is standalone (no transactions): single-document writes only;
  `removeRecipe` deletes ratings/cooks after the recipe.
- Dates are local (`TZ`, America/Chicago) `YYYY-MM-DD` strings.
- URL import (`src/import/`): `fetchPage` refuses non-http(s) and any hop
  resolving to a private/loopback/link-local address, 10 s, 2 MB, honest
  user agent (Budget Bytes blocks a fake browser UA; Allrecipes/Serious Eats
  block us regardless, so the error tells Claude to read the page itself).
  `schemaOrg.ts` maps the page's schema.org Recipe JSON-LD (top level,
  arrays, `@graph`, `mainEntity`; HowToSection headings become steps ending
  in `:`); keywords become tags only when short and not SEO repeats of the
  title, the author, course or cuisine. Tests use real pages trimmed to their
  ld+json in `test/fixtures/`; never hit the network.
- Recommender (`src/domain/recommend.ts`, pure; constants in
  `config.recommend`): per eater their stars, or unrated = their mean shrunk
  toward 3.5 by 3 pseudo-ratings; any eater ≤ 2 vetoes; family = mean −
  0.25 × (max − min); score = family − 2·e^(−days since made / 21) + 0.3 if
  no eater has rated it. `maxMinutes` leaves out recipes with no time.
  Every expected number in its tests is hand-derived; keep it that way.

## MCP

Tools in `src/mcp/server.ts`, stateless HTTP at `POST /recipes/mcp`,
`Authorization: Bearer <RECIPES_APP_TOKEN>`. There is no OAuth here: claude.ai
reaches it through mcp-gateway (`MCP_BACKENDS` `recipes=...`), so tool names
must not clash with other apps'.

## Deploy (Apache on signs)

Add next to /meet in `/etc/apache2/sites-enabled/000-default-le-ssl.conf`:

    ProxyPass        "/recipes" "http://localhost:3004/recipes"
    ProxyPassReverse "/recipes" "http://localhost:3004/recipes"

Backups: covered by the nightly Mongo dump in `ops/backup-signs`.
