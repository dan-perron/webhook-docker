import { describe, expect, it } from 'vitest';
import type { HockeySituation } from '../src/gamestate/types.js';
import { condBeat, homeWinProb } from '../src/models/mlb.js';
import { fitNhl, nhlScores, type NhlFit } from '../src/models/nhl.js';
import { resolvePrior } from '../src/models/prior.js';
import { parseEvents } from '../src/gamestate/espn.js';
import { fixture } from './helpers/fixtures.js';
import { PARAMS, state } from './helpers/states.js';

const EVEN: NhlFit = { home: 3, away: 3, emptyNet: 1 };
const hockey = (
  period: number,
  clock: number,
  postseason = false
): HockeySituation => ({
  kind: 'hockey',
  period,
  clock,
  postseason,
});
const at = (homeScore: number, awayScore: number, sit: HockeySituation) =>
  state('nhl', {
    homeScore,
    awayScore,
    situation: sit,
    fractionRemaining: 0.5,
  });

describe('nhlScores', () => {
  it('is a proper distribution with no ties', () => {
    const d = nhlScores(state('nhl', { status: 'pre' }), EVEN);
    expect(d.total()).toBeCloseTo(1, 9);
    for (const [h, a, p] of d.cells()) if (p > 1e-12) expect(h).not.toBe(a);
  });

  it('tied at the end of regulation, even teams: 50/50, winner by exactly one', () => {
    const d = nhlScores(at(2, 2, hockey(3, 0)), EVEN);
    expect(homeWinProb(d)).toBeCloseTo(0.5, 12);
    expect(d.get(3, 2) + d.get(2, 3)).toBeCloseTo(1, 12);
    // OT/SO winner by one: -1.5 never covers; +1.5 always does.
    expect(condBeat(d, 1.5, 'margin')).toBeCloseTo(0, 12);
    // The deciding goal counts in the total: always 5.
    expect(condBeat(d, 4.5, 'total')).toBeCloseTo(1, 12);
  });

  it('in the shootout: 50% plus a quarter of the strength edge', () => {
    // share 3.6 / 6 = 0.6 -> 0.5 + 0.1 x 0.25
    const d = nhlScores(at(1, 1, hockey(5, 0)), {
      home: 3.6,
      away: 2.4,
      emptyNet: 1,
    });
    expect(homeWinProb(d)).toBeCloseTo(0.525, 12);
  });

  it('playoff overtime is sudden death: the stronger team wins at its goal share', () => {
    const d = nhlScores(at(1, 1, hockey(4, 900, true)), {
      home: 3.6,
      away: 2.4,
      emptyNet: 1,
    });
    expect(homeWinProb(d)).toBeCloseTo(0.6, 12);
  });

  it('an empty net raises the leader’s chance to win by 2+ late', () => {
    // Home up 1 with 2:00 left: the trailing team pulls its goalie.
    const s = at(3, 2, hockey(3, 120));
    const weak = condBeat(
      nhlScores(s, { ...EVEN, emptyNet: 0.2 }),
      1.5,
      'margin'
    );
    const strong = condBeat(
      nhlScores(s, { ...EVEN, emptyNet: 2 }),
      1.5,
      'margin'
    );
    expect(strong).toBeGreaterThan(weak + 0.1);
    // ...and the trailing team's chance to tie is up from even strength.
    const pulledTie = nhlScores(s, EVEN);
    expect(homeWinProb(pulledTie)).toBeLessThan(1);
  });

  it('a 3-goal lead with 5 minutes left is nearly over', () => {
    expect(
      homeWinProb(nhlScores(at(4, 1, hockey(3, 300)), EVEN))
    ).toBeGreaterThan(0.99);
  });
});

describe('fitNhl (recorded 10/6 lines)', () => {
  it('CAR -1.5 +205 at MTL: matches moneyline, puck line and total', () => {
    const ev = parseEvents(
      'nhl',
      'nhl',
      fixture('espn/nhl-20261006-pre.json')
    ).find((e) => e.home.name.includes('Canadiens'))!;
    const p = resolvePrior('nhl', { espnLines: ev.pregameLines }, PARAMS);
    const fit = fitNhl(p);
    const d = nhlScores(state('nhl', { status: 'pre' }), fit);
    expect(homeWinProb(d)).toBeCloseTo(p.homeWin, 3);
    expect(condBeat(d, -p.spread!.line, 'margin')).toBeCloseTo(p.spread!.p, 3);
    expect(condBeat(d, p.totalLine!.line, 'total')).toBeCloseTo(
      p.totalLine!.p,
      3
    );
    // Plausible regulation scoring rates.
    expect(fit.home + fit.away).toBeGreaterThan(4);
    expect(fit.home + fit.away).toBeLessThan(8);
  });
});
