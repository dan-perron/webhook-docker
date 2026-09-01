import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context } from 'hono';
import { Layout, JsonScript } from '../views/layout.js';
import { JoinScreen, CollisionScreen, EventSummary } from '../views/join.js';
import { Everyone, MyGrid } from '../views/grid.js';
import { QuickFill } from '../views/quickfill.js';
import { BestPanel } from '../views/best.js';
import { getEventBySlug } from '../db/events.js';
import {
  applyChanges,
  claimParticipant,
  createParticipant,
  findByName,
  getById,
  getByToken,
  listForEvent,
  uniqueName,
  type SlotChange,
} from '../db/participants.js';
import type { EventDoc, Participant, SlotState } from '../db/types.js';
import {
  allMinutes,
  allSlotKeys,
  buildFillMap,
  slotKey,
} from '../util/slots.js';
import { makeClock, tzLabel } from '../util/clock.js';
import { isValidTimezone, timezoneOptions } from '../util/timezones.js';
import { setTimezone } from '../db/participants.js';
import { appConfig } from '../config.js';
import { basePath, url } from '../util/url.js';
import { absoluteUrl } from '../util/publicUrl.js';

export const event = new Hono();

const DEFAULT_DURATION = 60;
const MAX_CHANGES = 4000;

const cookieName = (slug: string) => `sched_${slug}`;

/**
 * Path-scoped to this event only. RFC 6265 path-matching requires a `/`
 * boundary, so `/meet/e/abc` is never sent to `/meet/e/abcx` — no cross-event
 * leak — while `/meet/e/abc/slots` still matches.
 *
 * Unsigned on purpose: the value is 128 random bits looked up server-side, so a
 * signature would add nothing. (calcium-tracker signs its cookie because that
 * one carries a guessable constant.)
 */
function setParticipantCookie(c: Context, slug: string, token: string) {
  setCookie(c, cookieName(slug), token, {
    path: `${basePath}/e/${slug}`,
    httpOnly: true,
    sameSite: 'Lax',
    secure: appConfig.cookieSecure,
    maxAge: 60 * 60 * 24 * 180,
  });
}

async function loadEvent(c: Context): Promise<EventDoc | null> {
  return getEventBySlug(c.req.param('slug') ?? '');
}

async function loadMe(c: Context, ev: EventDoc): Promise<Participant | null> {
  const token = getCookie(c, cookieName(ev.slug));
  if (!token) return null;
  return getByToken(ev._id!, token);
}

/** The zone a given viewer reads this event in. */
function clockFor(ev: EventDoc, me: Participant | null) {
  return makeClock(ev, me?.timezone || ev.timezone);
}

function parseDuration(c: Context, ev: EventDoc): number {
  const raw = Number(c.req.query('duration'));
  const span = ev.endMinute - ev.startMinute;
  if (!Number.isInteger(raw) || raw < ev.slotMinutes || raw > span) {
    return Math.min(DEFAULT_DURATION, span);
  }
  return Math.round(raw / ev.slotMinutes) * ev.slotMinutes;
}

const notFound = (c: Context) =>
  c.html(
    <Layout title="Not found">
      <section class="card">
        <h1 class="pagetitle">No such poll</h1>
        <p>
          That link does not match anything.{' '}
          <a href={url('/')}>Start a new one</a>.
        </p>
      </section>
    </Layout>,
    404
  );

event.get('/e/:slug', async (c) => {
  const ev = await loadEvent(c);
  if (!ev) return notFound(c);
  c.header('Cache-Control', 'no-store');

  const participants = await listForEvent(ev._id!);
  const me = await loadMe(c, ev);
  if (!me) {
    return c.html(
      <Layout title={ev.title}>
        <JoinScreen ev={ev} participants={participants} />
      </Layout>
    );
  }

  const duration = parseDuration(c, ev);
  const clock = clockFor(ev, me);
  const shareUrl = absoluteUrl(c, `/e/${ev.slug}`);

  return c.html(
    <Layout title={ev.title} withGrid>
      <section class="card eventhead">
        <h1 class="pagetitle">{ev.title}</h1>
        <EventSummary ev={ev} clock={clock} />
        <div class="whoami">
          <span>
            Answering as <strong>{me.name}</strong>.
          </span>
          <form method="post" action={url(`/e/${ev.slug}/switch`)}>
            <button type="submit" class="linkbtn">
              Not you?
            </button>
          </form>
        </div>
        <form
          method="post"
          action={url(`/e/${ev.slug}/timezone`)}
          class="tzpick"
        >
          <label>
            Show times in
            <select name="timezone" onchange="this.form.submit()">
              {timezoneOptions(clock.viewerTz, ev.timezone).map((zone) => (
                <option value={zone} selected={zone === clock.viewerTz}>
                  {tzLabel(zone)}
                  {zone === ev.timezone ? " (poll's own)" : ''}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" class="tzpick__go">
            Change
          </button>
        </form>
        <label class="share">
          Share this link
          <input
            type="text"
            id="sharelink"
            readonly
            value={shareUrl}
            onfocus="this.select()"
          />
        </label>
      </section>

      <JsonScript
        id="grid-data"
        value={{
          saveUrl: url(`/e/${ev.slug}/slots`),
          fills: buildFillMap(ev),
          dates: ev.dates,
          dow: Object.fromEntries(
            ev.dates.map((d) => [
              d,
              new Date(`${clock.columnDate(d)}T00:00:00`).getDay(),
            ])
          ),
        }}
      />
      <QuickFill ev={ev} clock={clock} />
      <MyGrid ev={ev} me={me} clock={clock} />
      <Everyone
        ev={ev}
        participants={participants}
        duration={duration}
        clock={clock}
      />
    </Layout>
  );
});

/**
 * Change the zone THIS person reads the grid in. Never touches slot keys, so
 * two people in different zones painting the same square still mean the same
 * instant — only the labels move.
 */
event.post('/e/:slug/timezone', async (c) => {
  const ev = await loadEvent(c);
  if (!ev) return notFound(c);
  const me = await loadMe(c, ev);
  if (!me) return c.redirect(url(`/e/${ev.slug}`), 303);
  const tz = String((await c.req.parseBody()).timezone ?? '');
  if (isValidTimezone(tz))
    await setTimezone(me, tz === ev.timezone ? null : tz);
  return c.redirect(url(`/e/${ev.slug}`), 303);
});

event.post('/e/:slug/join', async (c) => {
  const ev = await loadEvent(c);
  if (!ev) return notFound(c);

  const body = await c.req.parseBody();
  const back = () => c.redirect(url(`/e/${ev.slug}`), 303);

  // "I'm X" — claim an existing row. Rotates the token so a stale cookie
  // elsewhere stops working, which is what you want when a row changes hands.
  const claimId = String(body.claimId ?? '');
  if (claimId) {
    const existing = await getById(ev._id!, claimId);
    if (!existing) return back();
    const claimed = await claimParticipant(existing);
    setParticipantCookie(c, ev.slug, claimed.token);
    return back();
  }

  const name = String(body.name ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!name) return back();

  const forceNew = String(body.forceNew ?? '') === '1';
  const clash = await findByName(ev._id!, name);
  if (clash && !forceNew) {
    return c.html(
      <Layout title={ev.title}>
        <CollisionScreen ev={ev} existing={clash} />
      </Layout>
    );
  }

  // The join form carries the browser's own zone in a hidden field. Null when
  // it matches the event's, so "the poll's zone" stays the default meaning.
  const detected = String(body.timezone ?? '');
  const tz =
    isValidTimezone(detected) && detected !== ev.timezone ? detected : null;

  const finalName = clash ? await uniqueName(ev._id!, name) : name;
  const created = await createParticipant(ev._id!, finalName, tz);
  setParticipantCookie(c, ev.slug, created.token);
  return back();
});

// A POST, not a link: link prefetchers and mail scanners would otherwise sign
// people out just by looking at the page.
event.post('/e/:slug/switch', async (c) => {
  const slug = c.req.param('slug');
  deleteCookie(c, cookieName(slug), { path: `${basePath}/e/${slug}` });
  return c.redirect(url(`/e/${slug}`), 303);
});

/** Batched save from grid.js. Responds with the #everyone fragment. */
event.post('/e/:slug/slots', async (c) => {
  const ev = await loadEvent(c);
  if (!ev) return c.text('no such event', 404);
  const me = await loadMe(c, ev);
  if (!me) return c.text('not joined', 403);

  let payload: { changes?: unknown };
  try {
    payload = await c.req.json();
  } catch {
    return c.text('bad json', 400);
  }
  const incoming = Array.isArray(payload.changes) ? payload.changes : [];
  if (incoming.length > MAX_CHANGES) return c.text('too many changes', 400);

  const legal = allSlotKeys(ev);
  const changes: SlotChange[] = [];
  for (const raw of incoming) {
    const item = raw as { key?: unknown; value?: unknown };
    const key = String(item.key ?? '');
    const value = String(item.value ?? '');
    if (!legal.has(key)) continue;
    if (value !== 'yes' && value !== 'ifNeeded' && value !== 'none') continue;
    changes.push({ key, value: value as SlotState | 'none' });
  }
  await applyChanges(me, changes);

  const participants = await listForEvent(ev._id!);
  c.header('Cache-Control', 'no-store');
  return c.html(
    <Everyone
      ev={ev}
      participants={participants}
      duration={parseDuration(c, ev)}
      clock={clockFor(ev, me)}
    />
  );
});

/**
 * No-JS fallback. Toggles one cell (or one row/column) against the submitted
 * brush and redirects back. Built before grid.js so the JS stays a pure
 * enhancement — every bug in it is recoverable by turning JS off.
 */
event.post('/e/:slug/slots-form', async (c) => {
  const ev = await loadEvent(c);
  if (!ev) return notFound(c);
  const me = await loadMe(c, ev);
  if (!me) return c.redirect(url(`/e/${ev.slug}`), 303);

  const body = await c.req.parseBody();
  const brush: SlotState = body.brush === 'ifNeeded' ? 'ifNeeded' : 'yes';
  const legal = allSlotKeys(ev);

  let keys: string[] = [];
  const toggle = String(body.toggle ?? '');
  const fill = String(body.fill ?? '');
  if (toggle) {
    keys = [toggle];
  } else if (fill) {
    keys = buildFillMap(ev)[fill] ?? [];
  }
  keys = keys.filter((k) => legal.has(k));

  if (keys.length) {
    // Same rule as the drag: if everything already holds the brush value, erase.
    const allBrush = keys.every((k) => me.slots?.[k] === brush);
    const value: SlotState | 'none' = allBrush ? 'none' : brush;
    await applyChanges(
      me,
      keys.map((key) => ({ key, value }))
    );
  }
  return c.redirect(url(`/e/${ev.slug}`), 303);
});

/**
 * Quick fill: a band of hours on chosen weekdays. This is the path most people
 * should use — painting a week cell by cell is a lot of fiddly touching.
 */
event.post('/e/:slug/bulk', async (c) => {
  const ev = await loadEvent(c);
  if (!ev) return notFound(c);
  const me = await loadMe(c, ev);
  if (!me) return c.redirect(url(`/e/${ev.slug}`), 303);

  const body = await c.req.parseBody({ all: true });
  const from = Number(body.fromMinute);
  const to = Number(body.toMinute);
  const rawAction = String(body.action ?? '');
  const value: SlotState | 'none' =
    rawAction === 'yes'
      ? 'yes'
      : rawAction === 'ifNeeded'
        ? 'ifNeeded'
        : 'none';
  if (
    rawAction !== 'yes' &&
    rawAction !== 'ifNeeded' &&
    rawAction !== 'clear'
  ) {
    return c.redirect(url(`/e/${ev.slug}`), 303);
  }

  const rawDow = body.dow;
  const dow = new Set(
    (Array.isArray(rawDow) ? rawDow : rawDow === undefined ? [] : [rawDow]).map(
      Number
    )
  );
  if (
    !dow.size ||
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    to <= from
  ) {
    return c.redirect(url(`/e/${ev.slug}`), 303);
  }

  // Weekday is judged on the viewer's own labelling of each column.
  const clock = clockFor(ev, me);
  const changes: SlotChange[] = [];
  for (const date of ev.dates) {
    const weekday = new Date(`${clock.columnDate(date)}T00:00:00`).getDay();
    if (!dow.has(weekday)) continue;
    for (const m of allMinutes(ev)) {
      if (m >= from && m < to) changes.push({ key: slotKey(date, m), value });
    }
  }
  await applyChanges(me, changes);
  return c.redirect(url(`/e/${ev.slug}`), 303);
});

/** Copy one day's pattern onto the days you tick. Most weeks partly repeat. */
event.post('/e/:slug/copy-day', async (c) => {
  const ev = await loadEvent(c);
  if (!ev) return notFound(c);
  const me = await loadMe(c, ev);
  if (!me) return c.redirect(url(`/e/${ev.slug}`), 303);

  const body = await c.req.parseBody({ all: true });
  const source = String(body.from ?? '');
  if (!ev.dates.includes(source)) return c.redirect(url(`/e/${ev.slug}`), 303);

  const rawTo = body.to;
  const targets = (
    Array.isArray(rawTo) ? rawTo : rawTo === undefined ? [] : [rawTo]
  )
    .map(String)
    // Copying a day onto itself is a no-op, not an error — just drop it.
    .filter((d) => d !== source && ev.dates.includes(d));
  if (!targets.length) return c.redirect(url(`/e/${ev.slug}`), 303);

  const changes: SlotChange[] = [];
  for (const m of allMinutes(ev)) {
    const value = me.slots?.[slotKey(source, m)] ?? 'none';
    for (const date of targets) changes.push({ key: slotKey(date, m), value });
  }
  await applyChanges(me, changes);
  return c.redirect(url(`/e/${ev.slug}`), 303);
});

/** One renderer, two entry points — the poll and the save response can't drift. */
event.get('/e/:slug/everyone', async (c) => {
  const ev = await loadEvent(c);
  if (!ev) return c.text('no such event', 404);
  const participants = await listForEvent(ev._id!);
  c.header('Cache-Control', 'no-store');
  return c.html(
    <Everyone
      ev={ev}
      participants={participants}
      duration={parseDuration(c, ev)}
      clock={clockFor(ev, await loadMe(c, ev))}
    />
  );
});

/** `?full=1` gives a standalone, shareable version of just the proposals. */
event.get('/e/:slug/best', async (c) => {
  const ev = await loadEvent(c);
  if (!ev) return notFound(c);
  const participants = await listForEvent(ev._id!);
  const responders = participants.filter((p) => p.respondedAt);
  const waiting = participants.filter((p) => !p.respondedAt);
  const duration = parseDuration(c, ev);
  const clock = clockFor(ev, await loadMe(c, ev));
  const panel = (
    <BestPanel
      ev={ev}
      responders={responders}
      waiting={waiting}
      duration={duration}
      clock={clock}
    />
  );
  c.header('Cache-Control', 'no-store');
  if (c.req.query('full') !== '1') return c.html(panel);
  return c.html(
    <Layout title={`Best times — ${ev.title}`}>
      <section class="card">
        <h1 class="pagetitle">{ev.title}</h1>
        <EventSummary ev={ev} clock={clock} />
        <p>
          <a href={url(`/e/${ev.slug}`)}>Back to the grid</a>
        </p>
      </section>
      {panel}
    </Layout>
  );
});
