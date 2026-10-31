import { asc, eq, inArray } from 'drizzle-orm';
import { listBets, type BetWithLegs } from '../db/bets.js';
import type { Db } from '../db/client.js';
import {
  events,
  series,
  type BetRow,
  type EventRow,
  type LegRow,
  type SeriesRow,
} from '../db/schema.js';
import { winPayout } from '../domain/payout.js';
import {
  BET_ORIGINS,
  UNTAGGED,
  type BetOrigin,
  type BetStatus,
  type OriginFilter,
  type Side,
} from '../domain/types.js';
import type { GameState, SeriesState } from '../gamestate/types.js';
import type { Prior } from '../models/prior.js';
import { PROP_SPECS } from '../models/props.js';
import {
  betClose,
  legClv,
  parseClose,
  type CloseSource,
  type LegClose,
} from './clv.js';
import { valueBetRow } from './valuation.js';

// Read models for the MCP tools and the web page. Money in dollars, prices in
// American odds, probabilities 0..1. "model" numbers come from our models;
// "price"/"payout" numbers are what Dan entered from the book.

const dollars = (cents: number) => Math.round(cents) / 100;
const prob = (p: number | null | undefined) =>
  p == null ? null : Math.round(p * 10000) / 10000;
const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);

export function selectionLabel(l: LegRow): string {
  if (l.market === 'player_prop') {
    const spec = PROP_SPECS[l.propType!];
    if (l.selectionKind === 'yes')
      return `${l.playerName} ${spec.yesLabel ?? spec.label}`;
    const ou = l.selectionKind === 'over' ? 'Over' : 'Under';
    return `${l.playerName} ${ou} ${l.line} ${spec.label}`;
  }
  if (l.market === 'series_winner') return `${l.selectionTeam} to win series`;
  if (l.market === 'series_spread')
    return `${l.selectionTeam} ${signed(l.line!)} games (series)`;
  switch (l.selectionKind) {
    case 'draw':
      return 'Draw';
    case 'over':
      return `Over ${l.line}`;
    case 'under':
      return `Under ${l.line}`;
    default:
      return l.market === 'spread'
        ? `${l.selectionTeam} ${signed(l.line!)}`
        : `${l.selectionTeam} ML`;
  }
}

export interface LiveView {
  sport?: GameState['sport'];
  broadcasts?: GameState['broadcasts'];
  watch?: GameState['watch'];
  status: GameState['status'];
  detail: string;
  score: string;
  home: { name: string; abbr: string | null; score: number };
  away: { name: string; abbr: string | null; score: number };
  situation: GameState['situation'];
  /** The provider's own win probability (reference only, not our model). */
  providerWinProb: GameState['providerWinProb'];
  /** Scheduled start (ISO). */
  startTime: string;
  fetchedAt: string;
}

export function liveView(e: EventRow | undefined): LiveView | null {
  if (!e?.stateJson) return null;
  const s = JSON.parse(e.stateJson) as GameState;
  const tag = (c: GameState['home']) => c.abbr ?? c.name;
  return {
    sport: s.sport,
    broadcasts: s.broadcasts,
    watch: s.watch,
    status: s.status,
    detail: s.cancelled ? 'Cancelled' : s.detail,
    // Fights have no score; the leg's label already names both fighters.
    score:
      s.sport === 'mma'
        ? ''
        : `${tag(s.away)} ${s.away.score} @ ${tag(s.home)} ${s.home.score}`,
    home: s.home,
    away: s.away,
    situation: s.situation,
    providerWinProb: s.providerWinProb,
    startTime: s.startTime,
    fetchedAt: s.fetchedAt,
  };
}

/** A series leg's series: wins, and the game in progress or next up. */
export interface SeriesView {
  id: string;
  title: string | null;
  bestOf: number;
  status: SeriesState['status'];
  home: { name: string; abbr: string | null; wins: number };
  away: { name: string; abbr: string | null; wins: number };
  /** e.g. "MIL leads 1-0", "Series tied 2-2", "MIL wins 4-2". */
  summary: string;
  nextGame: {
    number: number;
    startTime: string;
    host: string;
    status: SeriesState['status'];
    detail: string;
    score: string | null;
  } | null;
  fetchedAt: string | null;
}

export function seriesSummary(s: {
  home: { name: string; abbr: string | null; wins: number };
  away: { name: string; abbr: string | null; wins: number };
  winner?: Side | null;
}): string {
  const tag = (t: { name: string; abbr: string | null }) => t.abbr ?? t.name;
  const [h, a] = [s.home.wins, s.away.wins];
  if (s.winner) {
    const [w, l] = s.winner === 'home' ? [s.home, s.away] : [s.away, s.home];
    return `${tag(w)} wins ${w.wins}-${l.wins}`;
  }
  if (h === a) return `Series tied ${h}-${a}`;
  return h > a
    ? `${tag(s.home)} leads ${h}-${a}`
    : `${tag(s.away)} leads ${a}-${h}`;
}

export function seriesView(r: SeriesRow | undefined): SeriesView | null {
  if (!r) return null;
  const st = r.stateJson ? (JSON.parse(r.stateJson) as SeriesState) : null;
  const home = {
    name: r.homeName,
    abbr: r.homeAbbr,
    wins: st?.home.wins ?? 0,
  };
  const away = {
    name: r.awayName,
    abbr: r.awayAbbr,
    wins: st?.away.wins ?? 0,
  };
  const played = home.wins + away.wins;
  const g =
    st?.games.find((x) => x.status === 'in') ??
    (st?.status === 'final'
      ? undefined
      : st?.games.find((x) => x.number === played + 1));
  const hostName = (id: string) =>
    id === r.homeTeamId ? r.homeName : r.awayName;
  return {
    id: r.id,
    title: r.title,
    bestOf: r.bestOf,
    status: r.status,
    home,
    away,
    summary: seriesSummary({ home, away, winner: st?.winner ?? null }),
    nextGame: g
      ? {
          number: g.number,
          startTime: g.startTime,
          host: hostName(g.homeTeamId),
          status: g.status,
          detail: g.detail,
          score:
            g.status === 'pre' || g.homeScore == null
              ? null
              : `${g.awayScore}-${g.homeScore}`,
        }
      : null,
    fetchedAt: st?.fetchedAt ?? null,
  };
}

export interface LegView {
  id: number;
  sport: LegRow['sport'];
  eventLabel: string;
  eventDate: string;
  market: LegRow['market'];
  selection: string;
  /**
   * Player props: the prop, player, his team, and TDs (anytime TD) or the
   * prop's stat so far (over/unders) once live.
   */
  prop?: {
    type: NonNullable<LegRow['propType']>;
    player: string;
    team: string | null;
    touchdowns?: number;
    stat?: { name: string; value: number };
    note?: string;
  };
  side: Side | null;
  line: number | null;
  priceAmerican: number;
  status: LegRow['status'];
  match: {
    status: LegRow['matchStatus'];
    eventId: string | null;
    /** Series markets: the series (eventId stays null). */
    seriesId?: string | null;
    candidates?: unknown;
  };
  /** Model P(win) now / P(push or void refund) now. */
  pWin: number | null;
  pPush: number | null;
  pWinAtPlacement: number | null;
  /** The market at close; null until resolved (and on bets older than CLV). */
  close: LegClose | null;
  /** close.p - pWinAtPlacement (probability points; positive = beat the close). */
  clv: number | null;
  /** close.p / pWinAtPlacement - 1. */
  clvPct: number | null;
  /** How pWinAtPlacement was derived (prior source, lines as of, anchor). */
  placement?: Record<string, unknown> | null;
  model: string | null;
  modelInputs?: Record<string, unknown>;
  /** Game legs: the model prior. Props: their de-vigged entered price. */
  prior?: Prior | { source: string; detail: string } | null;
  live: LiveView | null;
  /** Series markets: the series now. */
  series?: SeriesView | null;
}

function legView(
  l: LegRow,
  e: EventRow | undefined,
  full: boolean,
  s?: SeriesRow
): LegView {
  const candidates =
    l.matchStatus === 'needs_confirmation' && l.matchCandidatesJson
      ? (JSON.parse(l.matchCandidatesJson) as { event?: unknown }[]).map(
          ({ event: _e, ...c }) => c
        )
      : undefined;
  const inputs = l.modelInputsJson
    ? (JSON.parse(l.modelInputsJson) as Record<string, unknown>)
    : undefined;
  const prop =
    l.market === 'player_prop'
      ? {
          type: l.propType!,
          player: l.playerName!,
          team: l.selectionTeam,
          ...(typeof inputs?.touchdowns === 'number'
            ? { touchdowns: inputs.touchdowns }
            : {}),
          ...(propStat(l, inputs) ?? {}),
          ...(typeof inputs?.note === 'string' ? { note: inputs.note } : {}),
        }
      : undefined;
  const close = parseClose(l);
  const clv = legClv(l);
  return {
    id: l.id,
    sport: l.sport,
    eventLabel: l.eventLabel,
    eventDate: l.eventDate,
    market: l.market,
    selection: selectionLabel(l),
    ...(prop ? { prop } : {}),
    side: l.side,
    line: l.line,
    priceAmerican: l.priceAmerican,
    status: l.status,
    match: {
      status: l.matchStatus,
      eventId: l.eventId,
      ...(l.seriesId ? { seriesId: l.seriesId } : {}),
      ...(candidates ? { candidates } : {}),
    },
    pWin: prob(l.pWin),
    pPush: prob(l.pPush),
    pWinAtPlacement: prob(l.pWinPlacement),
    close: close && { ...close, p: prob(close.p) },
    clv: prob(clv?.clv),
    clvPct: prob(clv?.clvPct),
    model: l.model,
    ...(full
      ? {
          placement: l.placementJson ? JSON.parse(l.placementJson) : null,
          modelInputs: inputs,
          prior: l.priorJson
            ? (JSON.parse(l.priorJson) as LegView['prior'])
            : null,
        }
      : {}),
    live: liveView(e),
    ...(l.seriesId ? { series: seriesView(s) } : {}),
  };
}

/** An over/under prop's stat so far (e.g. points: 14), once live. */
function propStat(
  l: LegRow,
  inputs: Record<string, unknown> | undefined
): { stat: { name: string; value: number } } | null {
  const name = PROP_SPECS[l.propType!].label;
  const v = inputs?.[name];
  return l.propType !== 'anytime_td' && typeof v === 'number'
    ? { stat: { name, value: v } }
    : null;
}

export interface ValueView {
  /**
   * 'model'; 'book_implied' (same-game legs without a joint model); or
   * 'entered_price' (unmatched legs or player props valued at their
   * de-vigged entered price).
   */
  source: 'model' | 'book_implied' | 'entered_price';
  pWin: number;
  pPush: number;
  /** Expected return (dollars): P(win) x payout + push refunds. */
  value: number;
  /** value - stake (dollars). */
  ev: number;
}

/** The bet at the market's closing prices, boost included. */
export interface CloseView {
  /** Product of the legs' close.p; null when source has no price. */
  pWin: number | null;
  value: number | null;
  ev: number | null;
  source: CloseSource;
}

export interface BetView {
  id: number;
  book: string;
  externalBetId: string | null;
  placedAt: string | null;
  placedLive: boolean;
  type: BetRow['betType'];
  status: BetStatus;
  settledAt: string | null;
  label: string;
  stake: number;
  priceAmerican: number;
  boost: {
    pct: number;
    kind: string;
    boostedPriceAmerican: number | null;
  } | null;
  /** Return if it wins (dollars, stake included). */
  payout: number;
  payoutSource: string;
  tokenInfo: string | null;
  notes: string | null;
  /** recommended (Claude's +EV pick) | own (Dan's one-off) | null = untagged. */
  origin: BetOrigin | null;
  now: ValueView;
  atPlacement: ValueView | null;
  /** Null until every leg's close is resolved (and on bets older than CLV). */
  atClose: CloseView | null;
  /** atClose.pWin / P(win) at placement - 1. */
  clv: number | null;
  /** Open legs not matched to an event yet (present only when any). */
  unmatchedLegIds?: number[];
  /** Open player prop legs (present only when any). */
  propLegIds?: number[];
  /** Events with more than one leg in this bet (correlated legs). */
  sameGameEventIds: string[];
  legs: LegView[];
}

function valueView(v: {
  pWin: number;
  pPush: number;
  valueCents: number;
  evCents: number;
  pWinSource?: ValueView['source'];
}): ValueView {
  return {
    source: v.pWinSource ?? 'model',
    pWin: prob(v.pWin)!,
    pPush: prob(v.pPush)!,
    value: dollars(v.valueCents),
    ev: dollars(v.evCents),
  };
}

function seriesById(db: Db, legRows: LegRow[]): Map<string, SeriesRow> {
  const ids = [
    ...new Set(legRows.map((l) => l.seriesId).filter((x): x is string => !!x)),
  ];
  if (ids.length === 0) return new Map();
  return new Map(
    db
      .select()
      .from(series)
      .where(inArray(series.id, ids))
      .all()
      .map((s) => [s.id, s])
  );
}

function eventsById(db: Db, legRows: LegRow[]): Map<string, EventRow> {
  const ids = [
    ...new Set(legRows.map((l) => l.eventId).filter((x): x is string => !!x)),
  ];
  if (ids.length === 0) return new Map();
  return new Map(
    db
      .select()
      .from(events)
      .where(inArray(events.id, ids))
      .all()
      .map((e) => [e.id, e])
  );
}

/** Value of a bet whose result is known (cents). */
function settledValueCents(
  status: BetStatus,
  payoutCents: number,
  stakeCents: number
): number {
  if (status === 'won') return payoutCents;
  if (status === 'lost') return 0;
  return stakeCents; // push / void refund
}

export function betView(
  { bet, legs }: BetWithLegs,
  evs: Map<string, EventRow>,
  full = false,
  srs: Map<string, SeriesRow> = new Map()
): BetView {
  const v = valueBetRow(bet, legs);
  const payout = winPayout(bet, legs);
  const close = betClose(bet, legs);
  // A manual settle_bet can disagree with the legs; the recorded result wins.
  const manual = bet.status !== 'open' && bet.status !== v.now.status;
  const settledCents = settledValueCents(
    bet.status,
    payout.cents,
    bet.stakeCents
  );
  return {
    id: bet.id,
    book: bet.book,
    externalBetId: bet.externalBetId,
    placedAt: bet.placedAt,
    placedLive: bet.placedLive,
    type: bet.betType,
    status: bet.status,
    settledAt: bet.settledAt,
    label:
      legs.length === 1
        ? selectionLabel(legs[0]!)
        : `${legs.length}-leg parlay`,
    stake: dollars(bet.stakeCents),
    priceAmerican: bet.priceAmerican,
    boost: bet.boostPct
      ? {
          pct: bet.boostPct,
          kind: bet.boostKind!,
          boostedPriceAmerican: bet.boostedPriceAmerican,
        }
      : null,
    payout: dollars(payout.cents),
    payoutSource: payout.source,
    tokenInfo: bet.tokenInfo,
    notes: bet.notes,
    origin: bet.origin,
    now: valueView(
      manual
        ? {
            pWin: bet.status === 'won' ? 1 : 0,
            pPush: bet.status === 'push' || bet.status === 'void' ? 1 : 0,
            valueCents: settledCents,
            evCents: settledCents - bet.stakeCents,
          }
        : v.now
    ),
    atPlacement: v.atPlacement ? valueView(v.atPlacement) : null,
    atClose: close.atClose && {
      pWin: prob(close.atClose.pWin),
      value:
        close.atClose.valueCents == null
          ? null
          : dollars(close.atClose.valueCents),
      ev: close.atClose.evCents == null ? null : dollars(close.atClose.evCents),
      source: close.atClose.source,
    },
    clv: prob(close.clv),
    ...(v.unmatchedLegIds.length ? { unmatchedLegIds: v.unmatchedLegIds } : {}),
    ...(v.propLegIds.length ? { propLegIds: v.propLegIds } : {}),
    sameGameEventIds: v.now.sameGameEventIds,
    legs: legs.map((l) =>
      legView(
        l,
        l.eventId ? evs.get(l.eventId) : undefined,
        full,
        l.seriesId ? srs.get(l.seriesId) : undefined
      )
    ),
  };
}

export function betViews(
  db: Db,
  status?: BetStatus,
  origin?: OriginFilter
): BetView[] {
  const all = listBets(db, status, origin);
  const legRows = all.flatMap((b) => b.legs);
  const evs = eventsById(db, legRows);
  const srs = seriesById(db, legRows);
  return all.map((b) => betView(b, evs, false, srs));
}

export function betViewById(db: Db, b: BetWithLegs): BetView {
  return betView(b, eventsById(db, b.legs), true, seriesById(db, b.legs));
}

// --- Portfolio and exposure ---------------------------------------------------

export interface ExposureRow {
  betId: number;
  label: string;
  stake: number;
  /**
   * Expected P&L (dollars) if each outcome happens. Exact for moneyline
   * singles; for parlays it uses the other legs' current model P(win), and
   * spread/total legs on this event use their current P(win) (approx).
   */
  pnl: Record<string, number>;
  approx: boolean;
}

export interface Exposure {
  eventId: string;
  label: string;
  live: LiveView | null;
  outcomes: { key: 'home' | 'away' | 'draw'; name: string }[];
  rows: ExposureRow[];
  net: Record<string, number>;
}

/**
 * One origin's bets: stake, P/L and ROI, and EV at placement next to what
 * was realized (settled bets), so recommended picks can be checked against
 * Dan's own.
 */
export interface OriginBreakdown {
  origin: BetOrigin | typeof UNTAGGED;
  count: number;
  staked: number;
  open: { count: number; staked: number; ev: number };
  settled: {
    count: number;
    staked: number;
    returned: number;
    profit: number;
    /** profit / staked (null with nothing settled). */
    roi: number | null;
    /** Σ EV at placement of the settled bets that have one. */
    evAtPlacement: number;
    /** evAtPlacement / the stake it covers. */
    expectedRoi: number | null;
    /** profit - evAtPlacement over the same bets. */
    realizedVsExpected: number;
    /** Settled bets with no placement value (left out of the EV sums). */
    withoutPlacement: number;
  };
  /** Bets (open or settled) with a CLV: their games have started. */
  clvCount: number;
  /** Stake-weighted bet CLV (null with none). */
  avgClv: number | null;
  /** Legs with a CLV. */
  clvLegCount: number;
  /** Share of those legs with clv > 0 (null with none). */
  pctBeatClose: number | null;
  /** Σ EV at close of the bets with a CLV. */
  evAtClose: number;
  /** Σ EV at placement of those same bets, to set against evAtClose. */
  evAtPlacementWithClv: number;
  /** Realized profit of those bets that have settled. */
  profitWithClv: number;
}

export interface Portfolio {
  /** The origin filter applied, if any. */
  origin?: OriginFilter;
  open: { count: number; staked: number; value: number; ev: number };
  settled: { count: number; staked: number; returned: number; profit: number };
  byOrigin: OriginBreakdown[];
  exposure: Exposure[];
}

function exposureFor(e: EventRow, bets: BetWithLegs[]): Exposure {
  const outcomes: Exposure['outcomes'] = [
    { key: 'home', name: e.homeName },
    { key: 'away', name: e.awayName },
    ...(e.sport === 'soccer' ? [{ key: 'draw' as const, name: 'Draw' }] : []),
  ];
  const rows = bets.map(({ bet, legs }) => {
    const payout = winPayout(bet, legs).cents;
    let approx = false;
    const pnl: Record<string, number> = {};
    for (const o of outcomes) {
      let p = 1;
      for (const l of legs) {
        if (l.status === 'won' || l.status === 'push' || l.status === 'void')
          continue;
        if (l.status === 'lost') {
          p = 0;
          continue;
        }
        const onEvent = l.eventId === e.id;
        const resultDecided =
          onEvent && (l.market === 'moneyline' || l.market === 'moneyline3way');
        if (resultDecided) {
          const backed = l.selectionKind === 'draw' ? 'draw' : l.side;
          p *= backed === o.key ? 1 : 0;
        } else {
          if (onEvent) approx = true;
          p *= l.pWin ?? 0.5;
        }
      }
      pnl[o.key] = dollars(p * payout - bet.stakeCents);
    }
    return {
      betId: bet.id,
      label:
        legs.length === 1
          ? selectionLabel(legs[0]!)
          : `${legs.length}-leg parlay`,
      stake: dollars(bet.stakeCents),
      pnl,
      approx,
    };
  });
  const net = Object.fromEntries(
    outcomes.map((o) => [
      o.key,
      dollars(rows.reduce((a, r) => a + r.pnl[o.key]! * 100, 0)),
    ])
  );
  return {
    eventId: e.id,
    label:
      e.sport === 'mma'
        ? `${e.homeName} v ${e.awayName}`
        : `${e.awayName} @ ${e.homeName}`,
    live: liveView(e),
    outcomes,
    rows,
    net,
  };
}

export function portfolio(db: Db, origin?: OriginFilter): Portfolio {
  const all = listBets(db, undefined, origin);
  const views = new Map(betViews(db, undefined, origin).map((v) => [v.id, v]));
  const open = all.filter((b) => b.bet.status === 'open');
  const settled = all.filter((b) => b.bet.status !== 'open');

  // Events touched by two or more open bets.
  const byEvent = new Map<string, BetWithLegs[]>();
  for (const b of open) {
    for (const id of new Set(
      b.legs.map((l) => l.eventId).filter((x): x is string => !!x)
    )) {
      byEvent.set(id, [...(byEvent.get(id) ?? []), b]);
    }
  }
  const shared = [...byEvent].filter(([, bs]) => bs.length > 1);
  const evs = shared.length
    ? db
        .select()
        .from(events)
        .where(
          inArray(
            events.id,
            shared.map(([id]) => id)
          )
        )
        .orderBy(asc(events.startTime))
        .all()
    : [];

  const sum = (xs: number[]) =>
    Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;
  const ratio = (a: number, b: number) =>
    b > 0 ? Math.round((a / b) * 10000) / 10000 : null;
  const byOrigin = [...BET_ORIGINS, UNTAGGED].flatMap(
    (o): OriginBreakdown[] => {
      const vs = [...views.values()].filter(
        (v) => (v.origin ?? UNTAGGED) === o
      );
      if (!vs.length) return [];
      const op = vs.filter((v) => v.status === 'open');
      const st = vs.filter((v) => v.status !== 'open');
      const placed = st.filter((v) => v.atPlacement);
      const staked = sum(st.map((v) => v.stake));
      const profit = sum(st.map((v) => v.now.ev));
      const evAtPlacement = sum(placed.map((v) => v.atPlacement!.ev));
      const withClv = vs.filter((v) => v.clv != null);
      const clvStake = sum(withClv.map((v) => v.stake));
      const legClvs = vs.flatMap((v) => v.legs).filter((l) => l.clv != null);
      return [
        {
          origin: o,
          count: vs.length,
          staked: sum(vs.map((v) => v.stake)),
          open: {
            count: op.length,
            staked: sum(op.map((v) => v.stake)),
            ev: sum(op.map((v) => v.now.ev)),
          },
          settled: {
            count: st.length,
            staked,
            returned: sum(st.map((v) => v.now.value)),
            profit,
            roi: ratio(profit, staked),
            evAtPlacement,
            expectedRoi: ratio(evAtPlacement, sum(placed.map((v) => v.stake))),
            realizedVsExpected: sum([
              ...placed.map((v) => v.now.ev),
              -evAtPlacement,
            ]),
            withoutPlacement: st.length - placed.length,
          },
          clvCount: withClv.length,
          avgClv: ratio(
            withClv.reduce((a, v) => a + v.clv! * v.stake, 0),
            clvStake
          ),
          clvLegCount: legClvs.length,
          pctBeatClose: legClvs.length
            ? ratio(legClvs.filter((l) => l.clv! > 0).length, legClvs.length)
            : null,
          evAtClose: sum(withClv.map((v) => v.atClose!.ev!)),
          evAtPlacementWithClv: sum(withClv.map((v) => v.atPlacement?.ev ?? 0)),
          profitWithClv: sum(
            withClv.filter((v) => v.status !== 'open').map((v) => v.now.ev)
          ),
        },
      ];
    }
  );
  return {
    ...(origin ? { origin } : {}),
    open: {
      count: open.length,
      staked: sum(open.map((b) => b.bet.stakeCents / 100)),
      value: sum(open.map((b) => views.get(b.bet.id)!.now.value)),
      ev: sum(open.map((b) => views.get(b.bet.id)!.now.ev)),
    },
    settled: {
      count: settled.length,
      staked: sum(settled.map((b) => b.bet.stakeCents / 100)),
      returned: sum(settled.map((b) => views.get(b.bet.id)!.now.value)),
      profit: sum(settled.map((b) => views.get(b.bet.id)!.now.ev)),
    },
    byOrigin,
    exposure: evs.map((e) => exposureFor(e, byEvent.get(e.id)!)),
  };
}

export function eventRow(db: Db, id: string): EventRow | undefined {
  return db.select().from(events).where(eq(events.id, id)).get();
}
