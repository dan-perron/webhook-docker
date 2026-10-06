import { describe, expect, it } from 'vitest';
import type { Sport } from '../src/domain/types.js';
import { parseEvents } from '../src/gamestate/espn.js';
import type { PregameLines } from '../src/gamestate/types.js';
import { conditionalWin, evaluateEvent } from '../src/models/evaluate.js';
import { ensureFit } from '../src/models/fit.js';
import { resolvePrior, type LinesInput } from '../src/models/prior.js';
import type { ModelSelection } from '../src/models/types.js';
import { devig } from '../src/odds/math.js';
import { fixture } from './helpers/fixtures.js';
import { PARAMS, state } from './helpers/states.js';

// For every sport: a prior built from lines must reproduce the de-vigged
// probability of every main-line selection within 1 percentage point, from
// the fitted game model alone (no per-leg market anchor).

const TOL = 0.01;

const espn = (
  sport: Sport,
  league: string,
  file: string,
  home: string
): PregameLines =>
  parseEvents(sport, league, fixture(file)).find((e) =>
    e.home.name.includes(home)
  )!.pregameLines!;

function check(sport: Sport, lines: LinesInput) {
  const prior = ensureFit(
    sport,
    resolvePrior(sport, { espnLines: lines }, PARAMS),
    PARAMS
  );
  const pre = state(sport, { status: 'pre' });
  const cases: [string, ModelSelection, number][] = [];
  const ml = (side: 'home' | 'away', p: number) =>
    cases.push([
      `${side} ML`,
      { market: 'moneyline', kind: 'team', side, line: null },
      p,
    ]);
  if (sport === 'soccer') {
    const [h, d, a] = devig([
      lines.homeMoneyline!,
      lines.drawMoneyline!,
      lines.awayMoneyline!,
    ]).fair as [number, number, number];
    cases.push([
      'home',
      { market: 'moneyline3way', kind: 'team', side: 'home', line: null },
      h,
    ]);
    cases.push([
      'draw',
      { market: 'moneyline3way', kind: 'draw', side: null, line: null },
      d,
    ]);
    cases.push([
      'away',
      { market: 'moneyline3way', kind: 'team', side: 'away', line: null },
      a,
    ]);
  } else {
    const [h, a] = devig([lines.homeMoneyline!, lines.awayMoneyline!]).fair as [
      number,
      number,
    ];
    ml('home', h);
    ml('away', a);
  }
  if (lines.spreadHome != null && lines.spreadHomePrice != null) {
    const [h, a] = devig([lines.spreadHomePrice, lines.spreadAwayPrice!])
      .fair as [number, number];
    cases.push([
      `home ${lines.spreadHome}`,
      { market: 'spread', kind: 'team', side: 'home', line: lines.spreadHome },
      h,
    ]);
    cases.push([
      `away ${-lines.spreadHome}`,
      { market: 'spread', kind: 'team', side: 'away', line: -lines.spreadHome },
      a,
    ]);
  }
  if (lines.total != null && lines.overPrice != null) {
    const [o, u] = devig([lines.overPrice, lines.underPrice!]).fair as [
      number,
      number,
    ];
    cases.push([
      `over ${lines.total}`,
      { market: 'total', kind: 'over', side: null, line: lines.total },
      o,
    ]);
    cases.push([
      `under ${lines.total}`,
      { market: 'total', kind: 'under', side: null, line: lines.total },
      u,
    ]);
  }
  const out = evaluateEvent(
    sport,
    pre,
    prior,
    cases.map((c) => c[1]),
    { params: PARAMS }
  );
  return cases.map(([name, , market], i) => ({
    name,
    market,
    model: conditionalWin(out[i]!.outcome),
  }));
}

const expectWithin = (rows: ReturnType<typeof check>) => {
  if (process.env.SHOW_FIT)
    console.log(
      rows
        .map(
          (r) =>
            `${r.name} ${(100 * r.market).toFixed(2)} -> ${(100 * r.model).toFixed(2)}`
        )
        .join(' | ')
    );
  for (const r of rows) {
    expect(
      Math.abs(r.model - r.market),
      `${r.name}: model ${r.model.toFixed(4)} vs market ${r.market.toFixed(4)}`
    ).toBeLessThan(TOL);
  }
};

describe('pregame model reproduces the de-vigged market within 1 point', () => {
  it('MLB: CLE @ CWS 10/7 (bet #18 game), recorded DraftKings lines', () => {
    expectWithin(
      check(
        'mlb',
        espn('mlb', 'mlb', 'espn/mlb-20261007-pre.json', 'White Sox')
      )
    );
  });

  it('MLB: TB @ NYY 10/7, favorite at -1.5', () => {
    expectWithin(
      check('mlb', espn('mlb', 'mlb', 'espn/mlb-20261007-pre.json', 'Yankees'))
    );
  });

  it('NHL: CAR @ MTL and NSH @ TOR 10/6, recorded lines', () => {
    expectWithin(
      check(
        'nhl',
        espn('nhl', 'nhl', 'espn/nhl-20261006-pre.json', 'Canadiens')
      )
    );
    expectWithin(
      check(
        'nhl',
        espn('nhl', 'nhl', 'espn/nhl-20261006-pre.json', 'Maple Leafs')
      )
    );
  });

  it('WNBA: NY @ ATL and LV @ GSV 10/7, recorded lines', () => {
    expectWithin(
      check(
        'wnba',
        espn('wnba', 'wnba', 'espn/wnba-20261007-pre.json', 'Dream')
      )
    );
    expectWithin(
      check(
        'wnba',
        espn('wnba', 'wnba', 'espn/wnba-20261007-pre.json', 'Valkyries')
      )
    );
  });

  it('NFL: LAR @ PHI with a juiced +3.5 (key number)', () => {
    expectWithin(
      check('nfl', {
        homeMoneyline: 154,
        awayMoneyline: -185,
        drawMoneyline: null,
        spreadHome: 3.5,
        spreadHomePrice: -118,
        spreadAwayPrice: -102,
        total: 42.5,
        overPrice: -110,
        underPrice: -110,
      })
    );
  });

  it('NFL: integer spread (pushes possible), DET -3', () => {
    expectWithin(
      check('nfl', {
        homeMoneyline: -160,
        awayMoneyline: 135,
        drawMoneyline: null,
        spreadHome: -3,
        spreadHomePrice: -105,
        spreadAwayPrice: -115,
        total: 47,
        overPrice: -108,
        underPrice: -112,
      })
    );
  });

  it('NCAAF: UCF @ HOU closing line', () => {
    expectWithin(
      check('ncaaf', {
        homeMoneyline: -425,
        awayMoneyline: 330,
        drawMoneyline: null,
        spreadHome: -10.5,
        spreadHomePrice: -105,
        spreadAwayPrice: -115,
        total: 50.5,
        overPrice: -110,
        underPrice: -110,
      })
    );
  });

  it('Soccer: Portugal v Norway 3-way and total', () => {
    expectWithin(
      check('soccer', {
        homeMoneyline: -165,
        awayMoneyline: 330,
        drawMoneyline: 330,
        spreadHome: null,
        total: 3.5,
        overPrice: 110,
        underPrice: -130,
      })
    );
  });

  it('UFC: moneyline only', () => {
    expectWithin(
      check('mma', {
        homeMoneyline: -166,
        awayMoneyline: 140,
        drawMoneyline: null,
        spreadHome: null,
        total: null,
      })
    );
  });
});
