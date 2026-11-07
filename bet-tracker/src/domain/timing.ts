// Bet timing: how long before its game a leg was bet, and the bucket that
// puts it in for the CLV breakdowns. Pure; times are ISO strings.

export const TIMING_BUCKETS = ['>12h', '2-12h', '<2h'] as const;
export type TimingBucket = (typeof TIMING_BUCKETS)[number];

export interface PlacedTime {
  at: string | null;
  /**
   * 'entered' = bets.placed_at; 'created' = no placed_at, so when the bet
   * was entered here (an upper bound on when it was placed) when that was
   * before the game; null = neither.
   */
  source: 'entered' | 'created' | null;
}

/** placed_at, else created_at when it is before `firstStart`. */
export function placedTime(
  bet: { placedAt: string | null; createdAt: string },
  firstStart: string | null
): PlacedTime {
  if (bet.placedAt) return { at: bet.placedAt, source: 'entered' };
  if (firstStart && Date.parse(bet.createdAt) < Date.parse(firstStart))
    return { at: bet.createdAt, source: 'created' };
  return { at: null, source: null };
}

/** commence_time - placed_at in hours (negative = placed after the start). */
export function hoursBeforeStart(
  placedAt: string | null,
  commenceTime: string | null | undefined
): number | null {
  if (!placedAt || !commenceTime) return null;
  const ms = Date.parse(commenceTime) - Date.parse(placedAt);
  return Number.isFinite(ms) ? ms / 3_600_000 : null;
}

/** >12h | 2-12h (both ends included) | <2h (and anything after the start). */
export function timingBucket(hours: number | null): TimingBucket | null {
  if (hours == null) return null;
  if (hours > 12) return '>12h';
  if (hours >= 2) return '2-12h';
  return '<2h';
}
