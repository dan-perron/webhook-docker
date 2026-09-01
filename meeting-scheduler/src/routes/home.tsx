import { Hono } from 'hono';
import dayjs from 'dayjs';
import { Layout } from '../views/layout.js';
import { appConfig } from '../config.js';
import { createEvent } from '../db/events.js';
import { timeLabel } from '../util/slots.js';
import { isValidTimezone, timezoneOptions } from '../util/timezones.js';
import { tzLabel } from '../util/clock.js';
import { url } from '../util/url.js';

export const home = new Hono();

// One-hour slots. Half-hours doubled the number of squares to touch without
// adding signal anybody used — almost nobody's availability actually changes on
// the :30. Stored per-event, so this can move without breaking old polls.
const SLOT_MINUTES = 60;

/**
 * Limits exist to keep the page from becoming an unusable wall of cells, not
 * because anything breaks. Measured on this box: 90 dates x 18 slots renders in
 * ~70ms and gzips to 23KB, so the real cost is DOM nodes on a phone, not
 * bandwidth. These caps are set where the grid stops being readable. Hourly
 * slots halved the cell count, so they bind far less often than they used to.
 */
const MAX_DATES = 90;
const MAX_SLOTS_PER_DAY = 24;
const MAX_CELLS = 3000;

const DOW = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
];

interface FormState {
  error?: string;
  title?: string;
  from?: string;
  to?: string;
  dow?: Set<number>;
  startMinute?: number;
  endMinute?: number;
  timezone?: string;
}

function minuteOptions(from: number, to: number): number[] {
  const out: number[] = [];
  for (let m = from; m <= to; m += SLOT_MINUTES) out.push(m);
  return out;
}

function CreateForm(state: FormState) {
  const start = state.startMinute ?? 540;
  const end = state.endMinute ?? 1080;
  const tz = state.timezone ?? appConfig.defaultTimezone;
  const from = state.from ?? dayjs().format('YYYY-MM-DD');
  const to = state.to ?? dayjs().add(6, 'day').format('YYYY-MM-DD');
  const days = state.dow ?? new Set(DOW.map((d) => d.value));

  return (
    <section class="card">
      <h1 class="pagetitle">Find a time that works</h1>
      <p class="lede">
        Make a poll, send everyone the link, and they paint the times they are
        free. No accounts, no sign-ups.
      </p>
      {state.error ? <p class="error">{state.error}</p> : null}
      <form method="post" action={url('/events')} class="createform">
        <label>
          What is the meeting?
          <input
            name="title"
            type="text"
            placeholder="e.g. Team sync"
            maxlength={120}
            value={state.title ?? ''}
            required
            autofocus
          />
        </label>

        <div class="row">
          <label>
            First day
            <input
              name="from"
              type="date"
              class="datefield"
              value={from}
              required
            />
          </label>
          <label>
            Last day
            <input
              name="to"
              type="date"
              class="datefield"
              value={to}
              required
            />
          </label>
        </div>

        <fieldset class="dow">
          <legend>Which days count?</legend>
          {DOW.map((d) => (
            <label class="chip">
              <input
                type="checkbox"
                name="dow"
                value={String(d.value)}
                checked={days.has(d.value)}
              />
              <span>{d.label}</span>
            </label>
          ))}
        </fieldset>

        <div class="row">
          <label>
            No earlier than
            <select name="startMinute">
              {minuteOptions(0, 1440 - SLOT_MINUTES).map((m) => (
                <option value={String(m)} selected={m === start}>
                  {timeLabel(m)}
                </option>
              ))}
            </select>
          </label>
          <label>
            No later than
            <select name="endMinute">
              {minuteOptions(SLOT_MINUTES, 1440).map((m) => (
                <option value={String(m)} selected={m === end}>
                  {m === 1440 ? 'Midnight' : timeLabel(m)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label>
          Times are set in
          <select name="timezone">
            {timezoneOptions(tz).map((zone) => (
              <option value={zone} selected={zone === tz}>
                {tzLabel(zone)}
              </option>
            ))}
          </select>
        </label>
        <p class="fieldhint">
          This anchors the poll. Everyone else can read the grid in their own
          timezone — the app converts for them.
        </p>

        <button type="submit">Create the poll</button>
      </form>
    </section>
  );
}

home.get('/', (c) =>
  c.html(
    <Layout title="When Can We Meet" withDates>
      <CreateForm />
    </Layout>
  )
);

home.post('/events', async (c) => {
  const body = await c.req.parseBody({ all: true });

  const title = String(body.title ?? '').trim();
  const startMinute = Number(body.startMinute);
  const endMinute = Number(body.endMinute);
  const timezone = String(body.timezone ?? '');
  const fromRaw = String(body.from ?? '');
  const toRaw = String(body.to ?? '');

  const rawDow = body.dow;
  const allowed = new Set(
    (Array.isArray(rawDow) ? rawDow : rawDow === undefined ? [] : [rawDow]).map(
      Number
    )
  );

  const fail = (msg: string) =>
    c.html(
      <Layout title="When Can We Meet" withDates>
        <CreateForm
          error={msg}
          title={title}
          from={fromRaw || undefined}
          to={toRaw || undefined}
          dow={allowed.size ? allowed : undefined}
          startMinute={Number.isFinite(startMinute) ? startMinute : undefined}
          endMinute={Number.isFinite(endMinute) ? endMinute : undefined}
          timezone={isValidTimezone(timezone) ? timezone : undefined}
        />
      </Layout>,
      400
    );

  if (!title) return fail('Give the meeting a name.');
  if (!allowed.size) return fail('Pick at least one day of the week.');

  const from = dayjs(fromRaw);
  const to = dayjs(toRaw);
  if (!from.isValid() || !to.isValid() || to.isBefore(from, 'day')) {
    return fail('Check the first and last day.');
  }

  if (
    !Number.isInteger(startMinute) ||
    !Number.isInteger(endMinute) ||
    startMinute % SLOT_MINUTES !== 0 ||
    endMinute % SLOT_MINUTES !== 0 ||
    startMinute < 0 ||
    endMinute > 1440 ||
    startMinute >= endMinute
  ) {
    return fail('That time range does not make sense.');
  }

  const slotsPerDay = (endMinute - startMinute) / SLOT_MINUTES;
  if (slotsPerDay > MAX_SLOTS_PER_DAY) {
    return fail('Pick a narrower daily time range.');
  }

  const dates: string[] = [];
  for (let d = from; !d.isAfter(to, 'day'); d = d.add(1, 'day')) {
    if (allowed.has(d.day())) dates.push(d.format('YYYY-MM-DD'));
    if (dates.length > MAX_DATES) {
      return fail(
        `That range covers more than ${MAX_DATES} days. Shorten it, or untick some weekdays.`
      );
    }
  }
  if (!dates.length) {
    return fail('No days matched — check the range and the weekday boxes.');
  }

  const cells = slotsPerDay * dates.length;
  if (cells > MAX_CELLS) {
    const maxDays = Math.floor(MAX_CELLS / slotsPerDay);
    return fail(
      `${dates.length} days at ${(slotsPerDay * SLOT_MINUTES) / 60} hours a day is ${cells} squares — too many to read. ` +
        `Either shorten the range to about ${maxDays} days, or narrow the daily time range.`
    );
  }

  if (!isValidTimezone(timezone)) return fail('Pick a timezone from the list.');

  const ev = await createEvent({
    title,
    dates,
    startMinute,
    endMinute,
    slotMinutes: SLOT_MINUTES,
    timezone,
  });
  return c.redirect(url(`/e/${ev.slug}`), 303);
});
