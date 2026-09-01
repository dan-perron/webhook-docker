import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import type { EventDoc } from '../db/types.js';
import { allMinutes, timeLabel, shortTimeLabel } from './slots.js';

dayjs.extend(utc);
dayjs.extend(timezone);

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Renders an event's slots in whatever timezone the viewer is in.
 *
 * The grid's SHAPE never changes — same columns, same rows, same slot keys for
 * everyone — only the labels do. That is the whole trick. Re-projecting the
 * grid itself into each viewer's zone is what makes real When2Meet ragged: the
 * columns are dates, so a late slot lands on the next day and columns start
 * gaining and losing rows. Here a column is always "the event's Monday",
 * labelled with whatever date and times that is where you are sitting.
 */
export interface Clock {
  /** The viewer's IANA zone. */
  viewerTz: string;
  /** True when the viewer is in the event's own zone — the common case. */
  same: boolean;
  /** How many days the whole grid shifts for this viewer (usually 0). */
  headerOffset: number;
  /**
   * True when a clock change inside the date range makes a row land at
   * different local times on different dates, so the shared row label can only
   * be an example.
   */
  rowsUniform: boolean;
  /** "3:00 PM" for this slot in the viewer's zone. */
  label(date: string, minute: number): string;
  /** "3:00" — compact, for the row gutter. */
  short(date: string, minute: number): string;
  /** Days between the viewer's local date for this slot and the event's date. */
  offset(date: string, minute: number): number;
  /**
   * The viewer's own calendar date for ONE specific slot.
   *
   * Not the same as `columnDate`: a column is headed by its first slot, but a
   * later row in that column can fall on the next local day. Anything that
   * names a single moment on its own — a proposal, a cell's spoken label — must
   * use this, or it will be off by a day for anyone far enough east or west.
   */
  localDate(date: string, minute: number): string;
  /** The date a column is headed with, in the viewer's zone. */
  columnDate(date: string): string;
}

function project(ev: EventDoc, viewerTz: string, date: string, minute: number) {
  // A window can end at minute 1440 (midnight), which is 00:00 the next day.
  const dayShift = Math.floor(minute / 1440);
  const m = ((minute % 1440) + 1440) % 1440;
  const day = dayShift
    ? dayjs(date).add(dayShift, 'day').format('YYYY-MM-DD')
    : date;
  return dayjs
    .tz(`${day} ${pad(Math.floor(m / 60))}:${pad(m % 60)}`, ev.timezone)
    .tz(viewerTz);
}

export function makeClock(ev: EventDoc, viewerTz: string): Clock {
  const same = viewerTz === ev.timezone;

  if (same) {
    return {
      viewerTz,
      same: true,
      headerOffset: 0,
      rowsUniform: true,
      label: (_d, m) => timeLabel(m),
      short: (_d, m) => shortTimeLabel(m),
      offset: () => 0,
      localDate: (d) => d,
      columnDate: (d) => d,
    };
  }

  const offset = (date: string, minute: number) =>
    dayjs(project(ev, viewerTz, date, minute).format('YYYY-MM-DD')).diff(
      dayjs(date),
      'day'
    );

  // The whole grid shifts by however much its first row shifts.
  const headerOffset = offset(ev.dates[0], ev.startMinute);

  // If any date disagrees with the first about what local time a row is, the
  // range straddles a clock change and the shared gutter label is only an
  // example. Rare, but silently wrong labels are worse than a footnote.
  const rowsUniform = allMinutes(ev).every((m) => {
    const first = project(ev, viewerTz, ev.dates[0], m).format('HH:mm');
    return ev.dates.every(
      (d) => project(ev, viewerTz, d, m).format('HH:mm') === first
    );
  });

  return {
    viewerTz,
    same: false,
    headerOffset,
    rowsUniform,
    label: (d, m) => project(ev, viewerTz, d, m).format('h:mm A'),
    short: (d, m) => project(ev, viewerTz, d, m).format('h:mm'),
    offset,
    localDate: (d, m) => project(ev, viewerTz, d, m).format('YYYY-MM-DD'),
    columnDate: (d) => dayjs(d).add(headerOffset, 'day').format('YYYY-MM-DD'),
  };
}

/** "America/New_York" -> "America/New York" for display. */
export function tzLabel(tz: string): string {
  return tz.replace(/_/g, ' ');
}
