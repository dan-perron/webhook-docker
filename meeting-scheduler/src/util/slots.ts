import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import type { EventDoc } from '../db/types.js';

dayjs.extend(utc);
dayjs.extend(timezone);

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * `YYYY-MM-DD_HHMM`. Underscore rather than a dot because Mongo's update-path
 * parser cannot disambiguate `slots.2026-06-03.0900`. Also sorts
 * lexicographically and is readable in mongosh.
 */
export function slotKey(date: string, minute: number): string {
  return `${date}_${pad(Math.floor(minute / 60))}${pad(minute % 60)}`;
}

export function parseSlotKey(key: string): { date: string; minute: number } {
  const [date, hhmm] = key.split('_');
  return {
    date,
    minute: Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(2, 4)),
  };
}

/**
 * Start minutes for one date, grouped into contiguous runs. There is exactly
 * one run per date today; enumerating this way means a window can never
 * straddle a gap, so adding a lunch break later needs no rewrite.
 */
export function contiguousRuns(ev: EventDoc, _date: string): number[][] {
  const run: number[] = [];
  for (
    let m = ev.startMinute;
    m + ev.slotMinutes <= ev.endMinute;
    m += ev.slotMinutes
  ) {
    run.push(m);
  }
  return run.length ? [run] : [];
}

/** Every start minute in the daily window, flattened. */
export function allMinutes(ev: EventDoc): number[] {
  return contiguousRuns(ev, ev.dates[0]).flat();
}

/** Every legal slot key in the event. Used to reject junk from the save body. */
export function allSlotKeys(ev: EventDoc): Set<string> {
  const keys = new Set<string>();
  for (const date of ev.dates) {
    for (const m of allMinutes(ev)) keys.add(slotKey(date, m));
  }
  return keys;
}

/** "9:00 AM". Minute 1440 (a window ending at midnight) wraps to 12:00 AM. */
export function timeLabel(minute: number): string {
  const wrapped = ((minute % 1440) + 1440) % 1440;
  const h24 = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${pad(m)} ${h24 < 12 ? 'AM' : 'PM'}`;
}

/** "9:00" — compact form for the grid's time gutter. */
export function shortTimeLabel(minute: number): string {
  const wrapped = ((minute % 1440) + 1440) % 1440;
  const h24 = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${pad(m)}`;
}

/** "Mon Jun 3". Date-only strings parse as local, so no off-by-one shift. */
export function dateLabel(date: string): string {
  return dayjs(date).format('ddd MMM D');
}

/** "Monday, June 3" — for aria-labels, where abbreviations read badly. */
export function longDateLabel(date: string): string {
  return dayjs(date).format('dddd, MMMM D');
}

/** "Mon" / "Jun 3", split so the column header can stack them. */
export function dateHeaderParts(date: string): { dow: string; day: string } {
  const d = dayjs(date);
  return { dow: d.format('ddd'), day: d.format('MMM D') };
}

/**
 * The real UTC instant of the event's first slot. The client formats this with
 * toLocaleString to show "9:00 AM Chicago = 3:00 PM your time" — using an
 * instant rather than an offset subtraction makes it DST-correct for free.
 */
export function firstSlotInstant(ev: EventDoc): string {
  const [date] = ev.dates;
  const h = pad(Math.floor(ev.startMinute / 60));
  const m = pad(ev.startMinute % 60);
  return dayjs.tz(`${date} ${h}:${m}`, ev.timezone).toISOString();
}

/**
 * Row/column bulk-fill targets, precomputed server-side so grid.js never does
 * date math: `date:2026-06-03` and `time:0930` -> the slot keys they cover.
 */
export function buildFillMap(ev: EventDoc): Record<string, string[]> {
  const minutes = allMinutes(ev);
  const fills: Record<string, string[]> = {};
  for (const date of ev.dates) {
    fills[`date:${date}`] = minutes.map((m) => slotKey(date, m));
  }
  for (const m of minutes) {
    fills[`time:${pad(Math.floor(m / 60))}${pad(m % 60)}`] = ev.dates.map((d) =>
      slotKey(d, m)
    );
  }
  return fills;
}
