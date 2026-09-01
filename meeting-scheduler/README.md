# meeting-scheduler

A self-hosted When2Meet. Create a poll, send everyone the link, and they paint
the times they are free on a grid. The app ranks meeting windows by how many
people can actually attend, and names who can't.

No accounts and no passwords — you type your name on arrival and a cookie
remembers you. The event URL is the only access control.

**Picking dates.** A first day, a last day, and which weekdays count. The date
fields are native `<input type="date">`, so the browser's own calendar does the
picking — `public/datefield.js` just widens the tap target so anywhere in the
field opens it, not only the little icon. A poll can hold up to 90 days, subject
to a 3000-square total so the grid stays readable.

## Quick start

```bash
yarn install
yarn prepare              # husky hooks
export MONGODB_CONNSTRING="mongodb://localhost:27017"   # or your Mongo URI
yarn seed                 # demo poll with 14 fake participants
yarn start                # http://localhost:3002
```

## Configuration

`config/default.cjs` (override locally in `config/local.cjs`, which is gitignored):

| Setting          | Env var              | Default                           |
| ---------------- | -------------------- | --------------------------------- |
| Server port      | `PORT`               | `3002`                            |
| Base path        | `BASE_PATH`          | `''` (root); `/meet` in prod      |
| Mongo connection | `MONGODB_CONNSTRING` | `mongodb://localhost:27017`       |
| Mongo database   | `MONGODB_DATABASE`   | `scheduler`                       |
| Default timezone | `DEFAULT_TIMEZONE`   | `America/Chicago` (poll default)  |
| Secure cookies   | `COOKIE_SECURE`      | `true` (set `false` for http dev) |
| Asset cache bust | `ASSET_VERSION`      | `4`                               |
| Public origin    | `PUBLIC_ORIGIN`      | `''` (needed for share links)     |

`PUBLIC_ORIGIN` matters: the Apache vhost in front of this app does not set
`ProxyPreserveHost`, so the Host header the app sees is `localhost:3002`. Without
it the "share this link" box hands people a URL that only works on the server.

There is no auth. Every route is open; unguessable event slugs are the only
thing keeping polls private.

## How it works

**Two grids.** `#mygrid` is yours — interactive, server-rendered once, never
swapped. `#everyone` is the group heatmap plus the ranked proposals — read-only,
re-rendered as a fragment after every save and on a 15-second poll. Because the
interactive grid is never replaced, an incoming update can't clobber the cells
under your finger.

**Filling it in.** Most people should never touch the grid. The quick-fill panel
above it takes a band of hours and a set of weekdays and applies them in one go
("free, 9-12, Mon-Fri"), and "copy this day onto these days" handles the common
case where part of your week repeats — pick a source day, tick the days that
match. The grid below is for exceptions.

**Painting.** Slots are one hour. A visible brush (Free / If needed) says what
you are painting, then:

- Drag down a day to sweep out a block. Dragging back up shrinks it — the range
  is recomputed from the anchor each time rather than accumulated, so a drag can
  always be taken back.
- Grab the handle at the top or bottom of a block and drag to move just that
  end, like resizing an event in a calendar. The other end stays put.
- Tap a single hour to toggle it; tap a day or time label to fill that whole
  column or row.

A drag stays in the column it started in, the way dragging in a calendar does.

**No JavaScript required.** Every cell is a submit button in a form posting to
`/slots-form`, which toggles one cell (or a row/column) and redirects back.
`public/grid.js` intercepts those submits and replaces them with batched saves —
it is a pure enhancement, so anything it gets wrong is recoverable by turning JS
off.

**Ranking.** For a chosen duration, a person counts for a window only if they
hold up across every slot in it. Windows are ranked by how many people can
attend (`free + if-needed`) and then by how many are outright free — most people
in the room first, fewest inconvenienced second. Chronologically adjacent
windows with an identical roster are merged into one row with a start range, so
you get a proposal instead of a wall of near-duplicates. People who have never
answered are reported separately and never counted as "can't make it".

**Timezones are per person.** A poll is anchored to one zone, but each
participant reads the grid in their own — detected from their browser on join,
changeable any time from the event page. The grid's _shape_ never changes: same
columns, same rows, same slot keys for everyone, only the labels move. That is
what keeps it from going ragged the way real When2Meet does, where re-projecting
the grid makes columns gain and lose rows. A row that lands on the next
calendar day where you are is marked `+1`, and if a clock change falls inside
the date range the app says so rather than showing a silently wrong label.

## Data model (MongoDB `scheduler`)

- `events` — `{ slug, title, dates[], startMinute, endMinute, slotMinutes, timezone, adminToken, createdAt }`
- `participants` — `{ eventId, name, token, slots, timezone, respondedAt, createdAt, updatedAt }`
  - `timezone` is the zone THIS person reads times in; null means the poll's
    own. Slot keys stay anchored to the poll's zone regardless, so two people in
    different zones painting the same square always mean the same instant.
  - `slots` is sparse, keyed `YYYY-MM-DD_HHMM` → `yes` | `ifNeeded`. A missing
    key means not available. Underscore rather than a dot because Mongo's
    update-path parser can't disambiguate `slots.2026-06-03.0900`.
  - `respondedAt` is null until the first save. This is what separates "answered
    and is busy" from "never opened the link" — without it the can't-make-it
    list would be a lie.

## Development on `signs`

Mongo is **not** published to the host, so a plain `yarn start` can't reach it by
hostname. Run a dev container on the compose network instead — mongo resolves
exactly as in prod, the runtime is node:20 like prod, and there's no image
rebuild per edit:

```bash
cd /home/djperron/docker-compose/webhook-docker && set -a && . ./.env && set +a
docker run --rm -it --name meeting-scheduler-dev \
  --network webhook-docker_default \
  -v "$PWD/meeting-scheduler:/usr/src/app" \
  -w /usr/src/app -p 3012:3012 \
  -e MONGODB_CONNSTRING="mongodb://${MONGO_USERNAME}:${MONGO_PASSWORD}@mongodb/?authSource=admin" \
  -e MONGODB_DATABASE=scheduler_dev \
  -e BASE_PATH=/meet -e PORT=3012 -e COOKIE_SECURE=false \
  node:20 sh -c "yarn install && yarn dev:watch"
```

Port **3012**, not 3002, so it can't collide with the deployed service. Database
`scheduler_dev` so iterating can't scribble on real polls. `COOKIE_SECURE=false`
because over plain http the browser accepts a `Secure` cookie and then silently
never sends it back.

## Deploy (on `signs`)

Mongo runs in the `webhook-docker` compose stack and is only reachable on that
stack's network as hostname `mongodb`, so this deploys as a service in the same
stack. Unlike `calcium-tracker` it is a plain directory in that repo, not a
submodule — same as `personal-assistant`.

```bash
cd /home/djperron/docker-compose/webhook-docker
docker compose up -d --build meeting-scheduler
```

### Apache (path on the main domain)

Served under `BASE_PATH=/meet` on the existing Let's Encrypt domain — no new DNS
record or cert. The app is base-path aware, so the path passes through verbatim.
In the `*:443` vhost:

```apache
ProxyPass        "/meet" "http://localhost:3002/meet"
ProxyPassReverse "/meet" "http://localhost:3002/meet"
```

Then `sudo apachectl configtest && sudo systemctl reload apache2`.
