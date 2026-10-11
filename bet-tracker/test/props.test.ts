import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import {
  createBet,
  getBet,
  settleBet,
  settleLeg,
  updateLeg,
} from '../src/db/bets.js';
import { openDb, type Db } from '../src/db/client.js';
import { events } from '../src/db/schema.js';
import { betInputSchema, type BetInput } from '../src/domain/betInput.js';
import {
  parsePlayerStats,
  touchdownScorer,
  type EspnSummaryStats,
} from '../src/gamestate/espn.js';
import { createProviders } from '../src/gamestate/registry.js';
import type { GameState, PlayerStats } from '../src/gamestate/types.js';
import { matchLegs } from '../src/matching/service.js';
import { createMcpServer, type Services } from '../src/mcp/server.js';
import {
  evaluateProp,
  playerKey,
  playerTouchdowns,
  propPregame,
  type PropLeg,
} from '../src/models/props.js';
import { OddsApiClient } from '../src/odds/oddsApi.js';
import { Tracker } from '../src/tracker/tracker.js';
import { valueBetRow } from '../src/tracker/valuation.js';
import {
  betViewById,
  betViews,
  portfolio,
  type BetView,
} from '../src/tracker/views.js';
import { fakeFetcher, fixture } from './helpers/fixtures.js';
import { scoreService } from './helpers/scores.js';
import { PARAMS, state } from './helpers/states.js';
import { eq } from 'drizzle-orm';

// Player props (anytime TD) on recorded ESPN data: Lions @ Panthers 10/4
// (LaPorta 8 yd TD catch from Goff, Gibbs 1 yd TD run) and Bears @ Packers
// 10/11 at 1:53 of the 2nd quarter (Watson TD catch, Love's TD pass).

/** LaPorta +170 at the market (anytime TD hold 8%): (100/270)/1.08. */
const P_LAPORTA = 100 / 270 / 1.08;

const atdLeg = (
  player: string,
  team: string,
  price: number,
  over: Partial<BetInput['legs'][number]> = {}
): BetInput['legs'][number] => ({
  sport: 'nfl',
  eventDate: '2026-10-04',
  participants: ['Detroit Lions', 'Carolina Panthers'],
  market: 'player_prop',
  prop: { type: 'anytime_td', player, team },
  selection: { kind: 'yes' },
  price,
  ...over,
});

const laporta = (over: Partial<BetInput> = {}): BetInput => ({
  book: 'FanDuel',
  placedAt: '2026-10-04T14:00:00Z',
  stake: 25,
  price: 170,
  boostPct: 30,
  boostKind: 'profit_boost',
  boostedPrice: 222,
  statedPayout: 80.5,
  tokenInfo: '30% NFL Tier 2 Anytime TD boost',
  legs: [atdLeg('Sam LaPorta', 'Detroit Lions', 170)],
  ...over,
});

describe('player_prop input', () => {
  const issues = (leg: Partial<BetInput['legs'][number]>) => {
    const r = betInputSchema.safeParse(
      laporta({
        legs: [{ ...atdLeg('Sam LaPorta', 'Detroit Lions', 170), ...leg }],
      })
    );
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };

  it('accepts an anytime TD leg (line omitted or null)', () => {
    expect(issues({})).toEqual([]);
    expect(issues({ line: null })).toEqual([]);
  });

  it('rejects bad prop legs', () => {
    expect(issues({ prop: undefined })).toEqual([
      'player_prop needs prop {type, player, team}',
    ]);
    expect(
      issues({
        prop: { type: 'anytime_td', player: 'Sam LaPorta', team: 'Lions' },
      })
    ).toEqual(['prop.team "Lions" is not one of participants']);
    expect(issues({ line: 0.5 })).toEqual(['anytime_td takes no line']);
    expect(issues({ selection: { kind: 'over' } })).toEqual([
      'anytime_td selections: yes (got over)',
    ]);
    expect(issues({ sport: 'ncaaf' })).toEqual([
      'player props are supported for nfl only',
    ]);
  });

  it('keeps props and yes off game markets', () => {
    expect(
      issues({
        market: 'moneyline',
        selection: { kind: 'team', team: 'Detroit Lions' },
      })
    ).toEqual(['prop is only for market player_prop']);
    expect(
      issues({
        market: 'moneyline',
        prop: undefined,
        selection: { kind: 'yes' },
      })
    ).toEqual(['yes selections are for player props only']);
  });
});

describe('prop pricing', () => {
  it('de-vigs with 8% hold up to +200 and 15% above', () => {
    expect(propPregame('anytime_td', 170)).toEqual({
      p: P_LAPORTA,
      hold: 0.08,
    });
    // +200 is still "up to +200": (1/3)/1.08
    expect(propPregame('anytime_td', 200).p).toBeCloseTo(1 / 3 / 1.08, 12);
    // +250: (100/350)/1.15
    expect(propPregame('anytime_td', 250)).toEqual({
      p: 100 / 350 / 1.15,
      hold: 0.15,
    });
    // -120: (120/220)/1.08
    expect(propPregame('anytime_td', -120).p).toBeCloseTo(120 / 220 / 1.08, 12);
    // Configurable.
    expect(
      propPregame('anytime_td', 250, {
        anytimeTdHold: { upTo200: 0.05, above200: 0.1 },
      }).p
    ).toBeCloseTo(100 / 350 / 1.1, 12);
  });
});

describe('box score parsing', () => {
  const finalStats = () =>
    parsePlayerStats(
      fixture<EspnSummaryStats>('espn/summary-nfl-401872978-final.json'),
      '2026-10-04T21:00:00.000Z'
    )!;

  it('credits the scorer, not the passer', () => {
    expect(
      touchdownScorer('Sam LaPorta 8 Yd pass from Jared Goff (Jake Bates Kick)')
    ).toBe('Sam LaPorta');
    expect(
      touchdownScorer('Chuba Hubbard 15 Yd Rush (Ryan Fitzgerald Kick)')
    ).toBe('Chuba Hubbard');
    expect(
      touchdownScorer(
        'Jaylen Watson 98 Yd Kickoff Return (Harrison Butker Kick)'
      )
    ).toBe('Jaylen Watson');
    expect(touchdownScorer('Brian Branch Fumble Recovery in End Zone')).toBe(
      'Brian Branch Fumble Recovery in End Zone'
    );
  });

  it('names match across case, punctuation and suffixes', () => {
    expect(playerKey('Pierre Strong Jr.')).toBe(playerKey('pierre strong'));
    expect(playerKey('Amon-Ra St. Brown')).toBe(playerKey('AmonRa St Brown'));
    expect(playerKey('D.J. Moore')).toBe(playerKey('DJ Moore'));
  });

  it('reads the final box score and touchdown plays', () => {
    const s = finalStats();
    expect(s.final).toBe(true);
    const line = (name: string) => s.players.find((p) => p.name === name)!;
    expect(line('Sam LaPorta')).toMatchObject({
      team: 'Detroit Lions',
      stats: { receivingTouchdowns: 1 },
    });
    expect(line('Jared Goff').stats.passingTouchdowns).toBe(1);
    expect(line('Jahmyr Gibbs').stats.rushingTouchdowns).toBe(1);
    expect(s.touchdowns.map((t) => t.scorer)).toEqual([
      'Chuba Hubbard',
      'Tetairoa McMillan',
      'Jahmyr Gibbs',
      'Tetairoa McMillan',
      'Chuba Hubbard',
      'Sam LaPorta',
    ]);
    expect(playerTouchdowns(s, 'Sam LaPorta', 'Detroit Lions')).toMatchObject({
      count: 1,
      found: true,
    });
    // Two TD catches.
    expect(playerTouchdowns(s, 'Tetairoa McMillan', null).count).toBe(2);
    // Goff threw one and ran none: passing TDs don't count.
    expect(playerTouchdowns(s, 'Jared Goff', 'Detroit Lions')).toMatchObject({
      count: 0,
      found: true,
    });
    // Wrong team: no match.
    expect(playerTouchdowns(s, 'Sam LaPorta', 'Carolina Panthers').found).toBe(
      false
    );
  });

  it('a pregame (or empty) summary has no box score', () => {
    expect(
      parsePlayerStats(
        fixture<EspnSummaryStats>('espn/summary-nfl-401872991-pre.json'),
        'x'
      )
    ).toBeNull();
    expect(parsePlayerStats({}, 'x')).toBeNull();
  });
});

describe('evaluateProp (anytime TD)', () => {
  const leg: PropLeg = {
    propType: 'anytime_td',
    player: 'Sam LaPorta',
    team: 'Away',
    kind: 'yes',
    line: null,
  };
  const stats = (
    over: Partial<PlayerStats> & { tds?: number } = {}
  ): PlayerStats => ({
    final: false,
    players: [
      {
        name: 'Sam LaPorta',
        team: 'Away',
        stats: { receptions: 3, receivingTouchdowns: over.tds ?? 0 },
      },
    ],
    touchdowns: [],
    fetchedAt: 'x',
    ...over,
  });
  const p = P_LAPORTA;

  it('pregame, or live without a box score: the pregame value carries', () => {
    const pre = evaluateProp(leg, state('nfl', { status: 'pre' }), null, p);
    expect(pre).toMatchObject({
      outcome: { win: p, push: 0 },
      status: 'open',
      model: 'prop_pregame',
    });
    const live = evaluateProp(
      leg,
      state('nfl', { fractionRemaining: 0.3 }),
      null,
      p
    );
    expect(live.outcome.win).toBe(p);
    expect(live.inputs.note).toBe('no box score yet');
  });

  it('live with no TD yet: 1 - (1 - p)^f', () => {
    // Half the game left: 1 - sqrt(1 - 0.342936) = 0.189405
    const half = evaluateProp(
      leg,
      state('nfl', { fractionRemaining: 0.5 }),
      stats(),
      p
    );
    expect(half.outcome.win).toBeCloseTo(1 - Math.sqrt(1 - p), 12);
    expect(half.outcome.win).toBeCloseTo(0.189405, 6);
    expect(half).toMatchObject({ status: 'open', model: 'prop_live' });
    // Full game left: exactly the pregame value; none left: 0.
    expect(
      evaluateProp(leg, state('nfl', { fractionRemaining: 1 }), stats(), p)
        .outcome.win
    ).toBeCloseTo(p, 12);
    expect(
      evaluateProp(leg, state('nfl', { fractionRemaining: 0 }), stats(), p)
        .outcome.win
    ).toBe(0);
  });

  it('a TD live is a certain win (settles at the final)', () => {
    const r = evaluateProp(
      leg,
      state('nfl', { fractionRemaining: 0.6 }),
      stats({ tds: 1 }),
      p
    );
    expect(r).toMatchObject({
      outcome: { win: 1, push: 0 },
      status: 'open',
      inputs: { touchdowns: 1 },
    });
  });

  it('settles from the final box score', () => {
    const fin = state('nfl', { status: 'final', fractionRemaining: 0 });
    expect(
      evaluateProp(leg, fin, stats({ final: true, tds: 2 }), p).status
    ).toBe('won');
    expect(evaluateProp(leg, fin, stats({ final: true }), p)).toMatchObject({
      status: 'lost',
      outcome: { win: 0, push: 0 },
    });
    // Box score not marked complete yet: wait.
    expect(evaluateProp(leg, fin, stats({ tds: 1 }), p).status).toBe('open');
  });

  it('a player missing from the final box score needs a hand settle', () => {
    const fin = state('nfl', { status: 'final', fractionRemaining: 0 });
    const r = evaluateProp(
      { ...leg, player: 'Nobody Atall' },
      fin,
      stats({ final: true }),
      p
    );
    expect(r).toMatchObject({ status: 'open', model: 'prop_unverified' });
    expect(r.inputs.note).toMatch(/settle by hand/);
  });

  it('a cancelled game voids it', () => {
    expect(
      evaluateProp(
        leg,
        state('nfl', { status: 'final', cancelled: true }),
        null,
        p
      )
    ).toMatchObject({ status: 'void', outcome: { win: 0, push: 1 } });
  });
});

// --- Tracker, valuation, views, MCP on recorded games -----------------------

const routes: Record<string, string> = {};
let db: Db;
let clock: Date;
let tracker: Tracker;
let requested: string[];
let providers: ReturnType<typeof createProviders>;

const PRE = {
  'football/nfl/scoreboard?dates=20261004': 'espn/nfl-20261004-pre.json',
};
const FINAL = {
  'football/nfl/scoreboard?dates=20261004': 'espn/nfl-20261004-final.json',
  'football/nfl/summary?event=401872978':
    'espn/summary-nfl-401872978-final.json',
};
const LIVE = {
  'football/nfl/scoreboard?dates=20261011': 'espn/nfl-20261011-live.json',
  'football/nfl/summary?event=401872990':
    'espn/summary-nfl-401872990-live.json',
};
const useRoutes = (r: Record<string, string>) => {
  for (const k of Object.keys(routes)) delete routes[k];
  Object.assign(routes, r);
};

beforeEach(() => {
  useRoutes(PRE);
  db = openDb(':memory:');
  const fake = fakeFetcher(routes);
  requested = fake.requested;
  providers = createProviders(fake.fetcher);
  clock = new Date('2026-10-04T15:00:00.000Z');
  tracker = new Tracker(db, providers, {
    params: PARAMS,
    polling: { liveSeconds: 30, scheduledSeconds: 600 },
    now: () => clock,
  });
});

async function add(input: BetInput) {
  const b = createBet(db, input);
  await matchLegs(
    db,
    providers,
    b.legs.map((l) => l.id)
  );
  return b.bet.id;
}

const leg0 = (id: number) => getBet(db, id)!.legs[0]!;

describe('Tracker: player props', () => {
  it('matches the prop to the game, the player to his side', async () => {
    const id = await add(laporta());
    expect(leg0(id)).toMatchObject({
      matchStatus: 'matched',
      eventId: 'espn:nfl:401872978',
      side: 'away',
      selectionTeam: 'Detroit Lions',
      playerName: 'Sam LaPorta',
      propType: 'anytime_td',
      line: null,
    });
  });

  it('pregame: entered price de-vigged, source entered_price, no box score fetch', async () => {
    const id = await add(laporta());
    requested.length = 0;
    await tracker.tick();
    const l = leg0(id);
    expect(l).toMatchObject({
      status: 'open',
      model: 'prop_pregame',
      priorSource: 'entered_price',
    });
    expect(l.pWin).toBeCloseTo(P_LAPORTA, 12);
    expect(l.pWinPlacement).toBeCloseTo(P_LAPORTA, 12);
    expect(JSON.parse(l.placementJson!)).toEqual({
      source: 'entered_price',
      detail: '+170 de-vigged at 8% assumed anytime TD hold',
    });
    // Props use neither game lines nor box scores before kickoff.
    expect(requested.filter((u) => u.includes('summary'))).toEqual([]);

    const b = getBet(db, id)!;
    const v = valueBetRow(b.bet, b.legs);
    expect(v.propLegIds).toEqual([l.id]);
    // Stated payout $80.50: value 0.342936 x 80.50 = $27.61, EV +$2.61.
    expect(v.now).toMatchObject({
      pWinSource: 'entered_price',
      payoutCents: 8050,
    });
    expect(v.now.valueCents).toBeCloseTo(P_LAPORTA * 8050, 6);
    expect(v.atPlacement!.pWinSource).toBe('entered_price');

    const view = betViewById(db, b);
    expect(view).toMatchObject({
      label: 'Sam LaPorta anytime TD',
      now: { source: 'entered_price', value: 27.61, ev: 2.61 },
      atPlacement: { source: 'entered_price', ev: 2.61 },
      propLegIds: [l.id],
    });
    expect(view.legs[0]).toMatchObject({
      market: 'player_prop',
      selection: 'Sam LaPorta anytime TD',
      prop: {
        type: 'anytime_td',
        player: 'Sam LaPorta',
        team: 'Detroit Lions',
      },
      prior: { source: 'entered_price' },
    });
  });

  it('settles from the final box score: LaPorta TD catch won; Goff (TD pass only) lost', async () => {
    const lap = await add(laporta());
    const goff = await add(
      laporta({
        price: 1000,
        boostPct: undefined,
        boostKind: undefined,
        boostedPrice: undefined,
        statedPayout: undefined,
        legs: [atdLeg('Jared Goff', 'Detroit Lions', 1000)],
      })
    );
    const gibbs = await add(
      laporta({
        price: -150,
        boostPct: undefined,
        boostKind: undefined,
        boostedPrice: undefined,
        statedPayout: undefined,
        legs: [atdLeg('Jahmyr Gibbs', 'Detroit Lions', -150)],
      })
    );
    await tracker.tick();

    useRoutes(FINAL);
    clock = new Date('2026-10-04T21:00:00.000Z');
    await tracker.tick();
    expect(getBet(db, lap)!.bet.status).toBe('won');
    expect(leg0(lap)).toMatchObject({
      status: 'won',
      model: 'settled',
      pWin: 1,
    });
    expect(JSON.parse(leg0(lap).modelInputsJson!)).toMatchObject({
      touchdowns: 1,
      plays: 'Q4 3:38 Passing Touchdown',
    });
    expect(getBet(db, goff)!.bet.status).toBe('lost');
    expect(getBet(db, gibbs)!.bet.status).toBe('won');
    // Settled at the game's end, not when settlement ran.
    expect(getBet(db, lap)!.bet.settledAt).not.toBeNull();
    expect(getBet(db, lap)!.bet.settledAt! <= clock.toISOString()).toBe(true);

    const view = betViewById(db, getBet(db, lap)!);
    // Won: $80.50 back on $25.
    expect(view.now).toMatchObject({
      source: 'model',
      pWin: 1,
      value: 80.5,
      ev: 55.5,
    });
    expect(view.propLegIds).toBeUndefined();

    // The final box score is fetched once.
    requested.length = 0;
    clock = new Date('2026-10-04T21:05:00.000Z');
    await tracker.tick();
    expect(requested).toEqual([]);
  });

  it('a player not in the final box score stays open for a hand settle', async () => {
    const id = await add(
      laporta({
        price: 400,
        boostPct: undefined,
        boostKind: undefined,
        boostedPrice: undefined,
        statedPayout: undefined,
        legs: [atdLeg('Nobody Atall', 'Detroit Lions', 400)],
      })
    );
    useRoutes(FINAL);
    clock = new Date('2026-10-04T21:00:00.000Z');
    await tracker.tick();
    expect(leg0(id)).toMatchObject({
      status: 'open',
      model: 'prop_unverified',
    });
    expect(getBet(db, id)!.bet.status).toBe('open');
    const v = betViewById(db, getBet(db, id)!);
    expect(v.legs[0]!.prop!.note).toMatch(/settle by hand/);

    // Settle by hand; a recompute keeps it.
    settleBet(db, id, 'void');
    expect(leg0(id)).toMatchObject({
      status: 'void',
      model: 'manual',
      pPush: 1,
    });
    tracker.recomputeBet(id);
    expect(getBet(db, id)!.bet.status).toBe('void');
    expect(leg0(id).status).toBe('void');
  });

  it('live: a TD scorer is a lock; others decay with the clock; passing TDs ignored', async () => {
    const live = (player: string, team: string, price: number) =>
      laporta({
        price,
        boostPct: undefined,
        boostKind: undefined,
        boostedPrice: undefined,
        statedPayout: undefined,
        legs: [
          atdLeg(player, team, price, {
            eventDate: '2026-10-11',
            participants: ['Chicago Bears', 'Green Bay Packers'],
          }),
        ],
      });
    useRoutes(LIVE);
    clock = new Date('2026-10-11T18:06:00.000Z');
    const watson = await add(
      live('Christian Watson', 'Green Bay Packers', 150)
    );
    const love = await add(live('Jordan Love', 'Green Bay Packers', 900));
    const kmet = await add(live('Cole Kmet', 'Chicago Bears', 250));
    await tracker.tick();

    expect(leg0(watson)).toMatchObject({
      status: 'open',
      model: 'prop_live',
      pWin: 1,
    });
    const e = db
      .select()
      .from(events)
      .where(eq(events.id, 'espn:nfl:401872990'))
      .get()!;
    const f = (JSON.parse(e.stateJson!) as GameState).fractionRemaining;
    // 1:53 left in the 2nd quarter: (113 + 2 x 900) / 3600
    expect(f).toBeCloseTo(1913 / 3600, 6);
    // Kmet +250: p = (100/350)/1.15 = 0.248447;
    // 1 - 0.751553^0.531389 = 1 - e^(-0.285616 x 0.531389) = 0.140816
    const pKmet = 100 / 350 / 1.15;
    expect(leg0(kmet).pWin).toBeCloseTo(1 - (1 - pKmet) ** f, 12);
    expect(leg0(kmet).pWin).toBeCloseTo(0.140816, 5);
    // Love threw Watson's TD; he hasn't scored one.
    expect(leg0(love).pWin!).toBeLessThan(propPregame('anytime_td', 900).p);
    expect(JSON.parse(leg0(love).modelInputsJson!).touchdowns).toBe(0);
    // Placement is still the pregame price.
    expect(leg0(kmet).pWinPlacement).toBeCloseTo(pKmet, 12);

    // The box score follows each live poll.
    requested.length = 0;
    clock = new Date('2026-10-11T18:06:31.000Z');
    await tracker.tick();
    expect(
      requested.filter((u) => u.includes('summary?event=401872990'))
    ).toHaveLength(1);
  });

  it('live without a box score: carries the pregame value', async () => {
    useRoutes({
      'football/nfl/scoreboard?dates=20261011': 'espn/nfl-20261011-live.json',
    });
    clock = new Date('2026-10-11T18:06:00.000Z');
    const id = await add(
      laporta({
        price: 250,
        boostPct: undefined,
        boostKind: undefined,
        boostedPrice: undefined,
        statedPayout: undefined,
        legs: [
          atdLeg('Cole Kmet', 'Chicago Bears', 250, {
            eventDate: '2026-10-11',
            participants: ['Chicago Bears', 'Green Bay Packers'],
          }),
        ],
      })
    );
    await tracker.tick();
    // The fake fetcher answers an unknown summary with no box score.
    expect(leg0(id).pWin).toBeCloseTo(100 / 350 / 1.15, 12);
  });

  it('same-game parlay with a prop: no joint model, book price stands in', async () => {
    const id = await add(
      laporta({
        price: 300,
        boostPct: undefined,
        boostKind: undefined,
        boostedPrice: undefined,
        statedPayout: undefined,
        legs: [
          atdLeg('Sam LaPorta', 'Detroit Lions', 170),
          {
            sport: 'nfl',
            eventDate: '2026-10-04',
            participants: ['Detroit Lions', 'Carolina Panthers'],
            market: 'moneyline',
            selection: { kind: 'team', team: 'Detroit Lions' },
            price: -400,
          },
        ],
      })
    );
    await tracker.tick();
    const b = getBet(db, id)!;
    expect(b.bet.jointJson).toBeNull();
    expect(b.bet.jointPlacementJson).toBeNull();
    // The moneyline leg is still modeled from the game.
    expect(b.legs[1]!.model).toBe('football_normal');
    expect(valueBetRow(b.bet, b.legs).now.pWinSource).toBe('book_implied');

    // Settling the prop leg by hand re-derives the bet.
    settleLeg(db, b.legs[0]!.id, 'lost');
    expect(getBet(db, id)!.bet.status).toBe('lost');
    settleLeg(db, b.legs[0]!.id, 'open');
    expect(getBet(db, id)!.bet).toMatchObject({
      status: 'open',
      settledAt: null,
    });
  });

  it('update_leg keeps the player and team; price edits re-price the prop', async () => {
    const id = await add(laporta());
    await tracker.tick();
    const l = updateLeg(db, leg0(id).id, { price: 200 });
    expect(l).toMatchObject({
      priceAmerican: 200,
      selectionTeam: 'Detroit Lions',
      side: 'away',
      playerName: 'Sam LaPorta',
    });
    tracker.recomputeBet(id);
    expect(leg0(id).pWin).toBeCloseTo(1 / 3 / 1.08, 12);
    expect(() => updateLeg(db, leg0(id).id, { line: 0.5 })).toThrow(
      /takes no line/
    );
  });

  it('list_bets and portfolio include prop singles', async () => {
    await add(laporta());
    await tracker.tick();
    const [v] = betViews(db);
    expect(v!.label).toBe('Sam LaPorta anytime TD');
    expect(portfolio(db).open).toEqual({
      count: 1,
      staked: 25,
      value: 27.61,
      ev: 2.61,
    });
  });
});

describe('web page: prop bets', () => {
  it('shows the prop and its TDs once the game is on', async () => {
    useRoutes(LIVE);
    clock = new Date('2026-10-11T18:06:00.000Z');
    await add(
      laporta({
        price: 150,
        boostPct: undefined,
        boostKind: undefined,
        boostedPrice: undefined,
        statedPayout: undefined,
        legs: [
          atdLeg('Christian Watson', 'Green Bay Packers', 150, {
            eventDate: '2026-10-11',
            participants: ['Chicago Bears', 'Green Bay Packers'],
          }),
        ],
      })
    );
    await tracker.tick();
    const services: Services = {
      db,
      providers,
      tracker,
      scores: scoreService(db, providers, tracker, { now: () => clock }),
      odds: new OddsApiClient(db, {
        apiKey: '',
        baseUrl: 'x',
        regions: 'us',
        cacheSeconds: 60,
      }),
      confirmAboveCost: 3,
    };
    const app = createApp(services, {
      appToken: 't',
      publicOrigin: 'https://djperron.com',
      now: () => clock,
    });
    const login = await app.request('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ app_token: 't' }).toString(),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const html = await (await app.request('/', { headers: { cookie } })).text();
    expect(html).toContain('Christian Watson anytime TD');
    expect(html).toContain('Christian Watson: 1 TD');
  });
});

describe('MCP: player props', () => {
  let client: Client;
  beforeEach(async () => {
    const services: Services = {
      db,
      providers,
      tracker,
      scores: scoreService(db, providers, tracker),
      odds: new OddsApiClient(db, {
        apiKey: '',
        baseUrl: 'x',
        regions: 'us',
        cacheSeconds: 60,
      }),
      confirmAboveCost: 3,
    };
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createMcpServer(services).connect(a);
    client = new Client({ name: 'test', version: '1' });
    await client.connect(b);
  });
  const call = async <T>(name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[])[0]!.text;
    return {
      isError: !!r.isError,
      text,
      data: (r.isError ? null : JSON.parse(text)) as T,
    };
  };

  it('add_bet takes a player_prop leg; settle_bet settles one leg', async () => {
    const r = await call<{ bet: BetView; matching: unknown }>(
      'add_bet',
      laporta() as unknown as Record<string, unknown>
    );
    expect(r.isError).toBe(false);
    expect(r.data.matching).toBe('all legs matched');
    expect(r.data.bet).toMatchObject({
      label: 'Sam LaPorta anytime TD',
      payout: 80.5,
      now: { source: 'entered_price' },
    });
    const legId = r.data.bet.legs[0]!.id;
    const bad = await call('settle_bet', { id: 999, result: 'won', legId });
    expect(bad.isError).toBe(true);
    const s = await call<BetView>('settle_bet', {
      id: r.data.bet.id,
      result: 'won',
      legId,
    });
    expect(s.data).toMatchObject({ status: 'won', now: { value: 80.5 } });
    expect(s.data.legs[0]).toMatchObject({ status: 'won', model: 'manual' });
  });
});
