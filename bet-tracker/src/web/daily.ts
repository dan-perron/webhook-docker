import type { BetView } from '../tracker/views.js';

// Settled bets grouped by the local day they settled, with each day's
// record and money. "Today" is the viewer's today (their time zone).

export interface DayResults {
  /** YYYY-MM-DD in the viewer's zone ('' when the settle time is unknown). */
  day: string;
  label: string;
  bets: BetView[];
  won: number;
  lost: number;
  /** Pushes and voids (stake back). */
  push: number;
  staked: number;
  returned: number;
  /** returned - staked. */
  net: number;
}

const ymd = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone }).format(d);

function dayLabel(day: string, timeZone: string, now: Date): string {
  if (!day) return 'Settle time unknown';
  const today = ymd(now, timeZone);
  const yesterday = ymd(new Date(now.getTime() - 86_400_000), timeZone);
  if (day === today) return 'Today';
  if (day === yesterday) return 'Yesterday';
  // Noon UTC of that date formats to the same calendar day in any zone.
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(`${day}T12:00:00Z`));
}

const cents = (n: number) => Math.round(n * 100);

/** Settled bets grouped by settle day, newest day and newest bet first. */
export function settledByDay(
  bets: BetView[],
  timeZone: string,
  now: Date
): DayResults[] {
  const groups = new Map<string, BetView[]>();
  for (const b of bets) {
    if (b.status === 'open') continue;
    const day = b.settledAt ? ymd(new Date(b.settledAt), timeZone) : '';
    groups.set(day, [...(groups.get(day) ?? []), b]);
  }
  return [...groups]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : b.localeCompare(a)))
    .map(([day, list]) => {
      const sorted = [...list].sort((a, b) =>
        (b.settledAt ?? '').localeCompare(a.settledAt ?? '')
      );
      // Sum in cents so totals match the per-bet amounts shown.
      const staked = sorted.reduce((a, b) => a + cents(b.stake), 0);
      const returned = sorted.reduce((a, b) => a + cents(b.now.value), 0);
      return {
        day,
        label: dayLabel(day, timeZone, now),
        bets: sorted,
        won: sorted.filter((b) => b.status === 'won').length,
        lost: sorted.filter((b) => b.status === 'lost').length,
        push: sorted.filter((b) => b.status === 'push' || b.status === 'void')
          .length,
        staked: staked / 100,
        returned: returned / 100,
        net: (returned - staked) / 100,
      };
    });
}

/** "2W 1L 1P" (pushes only when there are some). */
export function record(d: Pick<DayResults, 'won' | 'lost' | 'push'>): string {
  return `${d.won}W ${d.lost}L${d.push ? ` ${d.push}P` : ''}`;
}

/** A browser-reported IANA zone, if valid; otherwise the fallback. */
export function validTimeZone(
  candidate: string | undefined,
  fallback: string
): string {
  if (!candidate || candidate.length > 64) return fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return candidate;
  } catch {
    return fallback;
  }
}
