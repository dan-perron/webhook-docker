import type { GameState } from '../gamestate/types.js';
import { betStatus } from './value.js';
import type { LegStatus, Sport } from './types.js';

// When a bet settled from final scores: when its deciding game ended, not
// when settlement happened to run (a bet re-entered days later must still
// land on the day its games finished).

/**
 * Typical minutes from scheduled start to final, used when the provider
 * publishes no end time. MMA start times are the card segment's, and a fight
 * can come up to ~3 hours into it.
 */
export const GAME_MINUTES: Record<Sport, number> = {
  nfl: 195,
  ncaaf: 210,
  mlb: 180,
  nhl: 155,
  wnba: 135,
  soccer: 115,
  mma: 150,
};

const ms = (s: string) => new Date(s).getTime();

/**
 * When an event finished: the provider's end time if it has one, otherwise
 * start + GAME_MINUTES. Capped by when we saw it final (and now), so a
 * quick game never settles in the future. Cancelled events use their start.
 */
export function eventFinalAt(
  sport: Sport,
  startTime: string,
  state: Pick<
    GameState,
    'status' | 'cancelled' | 'endTime' | 'fetchedAt'
  > | null,
  now: Date
): string {
  const caps = [now.getTime()];
  if (state?.status === 'final') caps.push(ms(state.fetchedAt));
  let t: number;
  if (state?.cancelled) t = ms(startTime);
  else if (state?.endTime) t = ms(state.endTime);
  else t = ms(startTime) + GAME_MINUTES[sport] * 60_000;
  return new Date(Math.min(t, ...caps)).toISOString();
}

/**
 * When a bet settled from its legs: a loss at its first losing leg's final,
 * anything else at its last leg's final. Null while open, or when a deciding
 * leg has no final time (e.g. a manual result the legs don't support).
 */
export function betSettledAt(
  legs: { status: LegStatus; finalAt: string | null }[]
): string | null {
  const status = betStatus(legs);
  if (status === 'open') return null;
  if (status === 'lost') {
    const lost = legs
      .filter((l) => l.status === 'lost' && l.finalAt != null)
      .map((l) => ms(l.finalAt!));
    return lost.length ? new Date(Math.min(...lost)).toISOString() : null;
  }
  if (legs.some((l) => l.finalAt == null)) return null;
  return new Date(Math.max(...legs.map((l) => ms(l.finalAt!)))).toISOString();
}
