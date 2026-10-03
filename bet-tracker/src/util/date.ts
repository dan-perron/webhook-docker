import { appConfig } from '../config.js';

/** YYYY-MM-DD of an instant in a time zone (default: the app's local TZ). */
export function localDate(iso: string, timeZone = appConfig.timezone): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

/** Add days to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const compactDate = (date: string) => date.replaceAll('-', '');
