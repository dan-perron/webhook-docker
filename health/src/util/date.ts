/** Calendar date (YYYY-MM-DD) of `at` in `timeZone`. */
export function localDate(at: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

const dayMs = 86_400_000;
const utc = (d: string) => Date.parse(`${d}T00:00:00Z`);

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round((utc(to) - utc(from)) / dayMs);
}

/** `date` plus `n` days (YYYY-MM-DD). */
export function addDays(date: string, n: number): string {
  return new Date(utc(date) + n * dayMs).toISOString().slice(0, 10);
}

/** Every date from `from` to `to`, inclusive. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export const WEEKDAYS = [
  'sun',
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** Day of the week of a YYYY-MM-DD date. */
export const weekdayOf = (date: string): Weekday =>
  WEEKDAYS[new Date(utc(date)).getUTCDay()]!;

export const isIsoDate = (s: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(utc(s)) && addDays(s, 0) === s;
