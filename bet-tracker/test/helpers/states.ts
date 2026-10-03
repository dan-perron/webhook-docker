import type { Sport } from '../../src/domain/types.js';
import type { GameState, Situation } from '../../src/gamestate/types.js';
import type { ModelParams, Prior } from '../../src/models/prior.js';

export const PARAMS: ModelParams = {
  football: {
    nfl: { marginSigma: 13.5, totalSigma: 13 },
    ncaaf: { marginSigma: 15, totalSigma: 14 },
  },
  mlb: { simulations: 20000 },
};

/** Build a GameState with sensible defaults for model tests. */
export function state(
  sport: Sport,
  over: Partial<GameState> & { homeScore?: number; awayScore?: number } = {}
): GameState {
  const { homeScore = 0, awayScore = 0, ...rest } = over;
  return {
    eventId: 'test:1',
    sport,
    status: 'in',
    cancelled: false,
    startTime: '2026-10-03T17:00:00.000Z',
    home: { name: 'Home', abbr: 'HOM', score: homeScore },
    away: { name: 'Away', abbr: 'AWY', score: awayScore },
    period: null,
    clockSeconds: null,
    detail: '',
    fractionRemaining: 1,
    situation: null as Situation | null,
    winner: null,
    providerWinProb: null,
    fetchedAt: '2026-10-03T19:00:00.000Z',
    ...rest,
  };
}

export function prior(over: Partial<Prior> = {}): Prior {
  return {
    source: 'neutral',
    homeWin: 0.5,
    draw: 0,
    awayWin: 0.5,
    expectedMargin: 0,
    expectedTotal: null,
    detail: 'test',
    ...over,
  };
}
