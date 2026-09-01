# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A self-hosted When2Meet. Someone creates a poll (a set of dates and a daily time
window), shares the link, and each person paints the hours they are
free. The app ranks meeting windows by how many people can attend and names who
can't. Runs on the `signs` home server in Docker behind Apache at
`https://djperron.com/meet`.

Identity is name-only: type your name, get a cookie. There is no auth layer at
all — unguessable event slugs are the only thing keeping polls private.

## Stack

- **TypeScript + Hono** on Node via `@hono/node-server`. ES modules
  (`"type":"module"`); all relative imports use `.js` extensions even though the
  source is `.ts`/`.tsx`. Compiles to `built/`.
- **Views**: `hono/jsx` server-rendered HTML. `tsconfig` sets `jsx: react-jsx` +
  `jsxImportSource: hono/jsx`.
- **HTMX** (vendored at `public/htmx.min.js`, v2.0.4) drives the group-view
  refresh. Two hand-written files: `public/grid.js` (drag-to-paint on the
  availability grid) and `public/datefield.js` (opens the native calendar from
  anywhere in a date field).
- **MongoDB** driver v6, database `scheduler`.
- **config** package: `config/default.cjs` committed, `config/local.cjs`
  gitignored. `MONGODB_CONNSTRING` comes from env.

## Development Commands

```bash
yarn build         # tsc -> built/
yarn start         # build + run
yarn dev:watch     # tsc -w + node --watch (use this in the dev container)
yarn seed          # demo poll with 14 fake participants
yarn lint:check    # eslint
yarn format:check  # prettier
yarn fix           # lint:fix + format:write
yarn deploy        # ./deploy.sh (run ON signs)
```

See README "Development on `signs`" for the dev-container command — mongo is not
published to the host, so a plain `yarn start` there cannot reach it.

## Architecture

- `src/server.ts` — entry point; `ensureIndexes()` then `serve()`.
- `src/app.ts` — builds the Hono app, mounts `public/`, routes, `/healthz`.
- `src/db/` — `connection.ts` (client + collections + indexes), `events.ts`,
  `participants.ts`. `types.ts` holds the document shapes.
- `src/routes/` — `home.tsx` (create form + `POST /events`), `event.tsx`
  (everything under `/e/:slug`).
- `src/views/` — `layout.tsx` (shell + `JsonScript`), `join.tsx`, `grid.tsx`
  (`MyGrid` + `Everyone`), `best.tsx` (`BestPanel`).
- `src/util/` — `url.ts` (base-path prefixing), `slots.ts` (slot keys, labels,
  fill maps), `clock.ts` (per-viewer timezone projection), `timezones.ts`,
  `scoring.ts` (pure ranking logic), `id.ts`.
- `src/views/quickfill.tsx` — bulk fill by hour-band + weekday, and copy-day.
- `public/grid.js` — the paint interaction. No build step, no framework.

## Things that are the way they are on purpose

- **Two grids.** `#mygrid` is interactive and is server-rendered exactly once —
  it is never swapped. `#everyone` is read-only and is the only thing that gets
  re-rendered. This is why there is no "don't clobber the cells under the user's
  finger" problem to solve. Do not merge them.
- **The brush, not a tap-cycle.** With three states, "the first cell of a drag
  decides what you paint" is ambiguous if tapping cycles through states — you'd
  arm a long drag based on the incidental prior state of one cell. A visible
  brush plus "already the brush value ⇒ erase, else paint" is one rule for taps,
  drags, bulk fills, and the no-JS path alike.
- **A drag is a RANGE, recomputed from a snapshot — not accumulated painting.**
  `applyRange()` restores the column to its pre-drag snapshot and then lays the
  range on top, every move. That is the only reason a drag can shrink; a
  paint-as-you-touch model can only ever grow, which makes overshooting
  unrecoverable without a second erase pass. Resizing additionally blanks the
  block being resized before laying the range down, or pulling an edge inward
  would leave the old squares filled.
- **Resize vs tap is settled by movement, not by position.** A press inside a
  block's edge strip only becomes a resize once the pointer travels
  `MOVE_THRESHOLD`. Without that, tapping the top square of a block would start
  a zero-length resize and silently do nothing instead of toggling.
- **Drags are locked to one column.** Set at pointerdown and never re-read, the
  way dragging in a calendar behaves. Cross-column marking is what the row-fill
  labels and quick fill are for.
- **The no-JS path is the real path.** `/slots-form` implements the same toggle
  rule server-side; `grid.js` intercepts and batches. Keep them in sync — if you
  change the paint rule, change both.
- **`htmx.swap()`, not `innerHTML`.** The `#everyone` fragment carries `hx-*`
  attributes (poll trigger, duration select). `innerHTML` leaves them inert and
  the duration dropdown silently stops working.
- **`touch-action: none` is on `.cell`, never on `.grid-scroll`.** On the
  container it makes a grid wider than the phone impossible to pan.
- **`pointercancel` commits.** iOS fires it for system gestures; reverting would
  discard real work.
- **Keyboard clicks are detected by `event.detail === 0`.** That is what keeps
  the pointer path and the keyboard path from double-firing.
- **`respondedAt`** separates "answered and is busy" from "never opened the
  link". Non-responders are never counted as "can't make it".
- **Ranking is `(free + ifNeeded)` desc, then `free` desc.** Not a weighted
  score (the weight would be a magic number) and not lexicographic on
  `(free, ifNeeded)` (that ranks 10-free/0-maybe over 9-free/5-maybe, but more
  people in the room wins).
- **`merge()` requires chronological input.** Merge adjacent windows first, then
  sort by score. Never the other way round.
- **Slot keys use `_`, not `.`** — `$set: {"slots.2026-06-03.0900": ...}` is
  ambiguous to Mongo's update-path parser.
- **Per-viewer timezones move labels, never structure.** `makeClock(ev, tz)`
  returns label functions; the grid's columns, rows, and slot keys are identical
  for every viewer. Re-projecting the grid itself into each zone is what makes
  real When2Meet ragged. Never do that.
- **`clock.localDate(date, minute)` vs `clock.columnDate(date)`.** A column is
  headed by its FIRST slot, so a later row in the same column can fall on the
  next local day. Anything naming a single moment on its own — a proposal, a
  cell's aria-label — must use `localDate`, or it is off by a day for viewers
  far enough east or west. This was a real bug; don't reintroduce it.
- **Slot keys are anchored to the event's zone, always.** Two people in
  different zones painting "the same square" must mean the same instant.
- **Never build a shareable URL from `c.req.url`.** The main Apache vhost has no
  `ProxyPreserveHost`, so the Host header here is `localhost:3002`. Use
  `absoluteUrl()` (`src/util/publicUrl.ts`), which prefers `PUBLIC_ORIGIN`, then
  `X-Forwarded-Host`, then the request; grid.js also corrects the field from
  `window.location`. This was a real bug.
- **Slots are one hour** (`SLOT_MINUTES` in `routes/home.tsx`). Half-hours
  doubled the squares to touch for signal nobody used. The value is stored per
  event as `slotMinutes` and every consumer reads it from there, so changing it
  again does not break existing polls — but `DURATIONS` in `views/best.tsx` must
  stay whole multiples of it.
- **Quick fill is the primary input, the grid is for exceptions.** Painting a
  week cell by cell is a lot of fiddly touching on a phone. `/bulk` and
  `/copy-day` are plain form POSTs that work with no JS; grid.js intercepts both
  purely to skip the reload. Three implementations of the same intent now exist
  (server bulk, server copy-day, client interception) — keep them in step.
- **Date selection uses native `<input type="date">`, not a custom calendar.**
  There was a hand-built four-month inline picker here; it was replaced because
  it dominated the page for no gain. The browser's own calendar is better than
  anything worth rebuilding, and `datefield.js` is only a tap-target widener.
  Don't reintroduce a custom calendar widget.
- **Touch targets scale on `(pointer: coarse)`.** Cells go 34px -> 42px. Costs
  scrolling, which the sticky headers and the 70vh grid box absorb.
- **Cookies are unsigned and path-scoped** to `${basePath}/e/${slug}`. The value
  is 128 random bits looked up server-side, so signing adds nothing (unlike
  calcium-tracker, whose cookie carries a guessable constant).

## Deployment

Deployed as a service in the `webhook-docker` compose stack, as a **plain
directory, not a git submodule** (same as `personal-assistant`; `calcium-tracker`
and `webhook-server` are the submodules). App port 3002, served under
`BASE_PATH=/meet` via a `ProxyPass` pair in the main `*:443` vhost — the path
passes through verbatim because the app is base-path aware.

```bash
cd /home/djperron/docker-compose/webhook-docker
docker compose up -d --build meeting-scheduler
```

Bump `ASSET_VERSION` when `grid.js`, `datefield.js`, or `styles.css` changes.

## Conventions

- ESLint + Prettier (single quotes, 2-space, es5 trailing commas); husky
  pre-commit runs `build && lint:check && format:check`.
- Unused vars allowed if prefixed `_`.
