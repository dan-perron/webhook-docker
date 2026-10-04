import { asc, eq, inArray } from 'drizzle-orm';
import { listBets, type BetWithLegs } from '../db/bets.js';
import type { Db } from '../db/client.js';
import {
  events,
  type BetRow,
  type EventRow,
  type LegRow,
} from '../db/schema.js';
import { winPayout } from '../domain/payout.js';
import type { BetStatus, Side } from '../domain/types.js';
import type { GameState } from '../gamestate/types.js';
import type { Prior } from '../models/prior.js';
import { valueBetRow } from './valuation.js';

// Read models for the MCP tools and the web page. Money in dollars, prices in
// American odds, probabilities 0..1. "model" numbers come from our models;
// "price"/"payout" numbers are what Dan entered from the book.

const dollars = (cents: number) => Math.round(cents) / 100;
const prob = (p: number | null | undefined) =>
  p == null ? null : Math.round(p * 10000) / 10000;
const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);

export function selectionLabel(l: LegRow): string {
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

export interface LegView {
  id: number;
  sport: LegRow['sport'];
  eventLabel: string;
  eventDate: string;
  market: LegRow['market'];
  selection: string;
  side: Side | null;
  line: number | null;
  priceAmerican: number;
  status: LegRow['status'];
  match: {
    status: LegRow['matchStatus'];
    eventId: string | null;
    candidates?: unknown;
  };
  /** Model P(win) now / P(push or void refund) now. */
  pWin: number | null;
  pPush: number | null;
  pWinAtPlacement: number | null;
  model: string | null;
  modelInputs?: Record<string, unknown>;
  prior?: (Prior & { source: string }) | null;
  live: LiveView | null;
}

function legView(l: LegRow, e: EventRow | undefined, full: boolean): LegView {
  const candidates =
    l.matchStatus === 'needs_confirmation' && l.matchCandidatesJson
      ? (JSON.parse(l.matchCandidatesJson) as { event?: unknown }[]).map(
          ({ event: _e, ...c }) => c
        )
      : undefined;
  return {
    id: l.id,
    sport: l.sport,
    eventLabel: l.eventLabel,
    eventDate: l.eventDate,
    market: l.market,
    selection: selectionLabel(l),
    side: l.side,
    line: l.line,
    priceAmerican: l.priceAmerican,
    status: l.status,
    match: {
      status: l.matchStatus,
      eventId: l.eventId,
      ...(candidates ? { candidates } : {}),
    },
    pWin: prob(l.pWin),
    pPush: prob(l.pPush),
    pWinAtPlacement: prob(l.pWinPlacement),
    model: l.model,
    ...(full
      ? {
          modelInputs: l.modelInputsJson
            ? JSON.parse(l.modelInputsJson)
            : undefined,
          prior: l.priorJson ? (JSON.parse(l.priorJson) as Prior) : null,
        }
      : {}),
    live: liveView(e),
  };
}

export interface ValueView {
  /** 'model', or 'book_implied' (same-game legs without a joint model). */
  source: 'model' | 'book_implied';
  pWin: number;
  pPush: number;
  /** Expected return (dollars): P(win) x payout + push refunds. */
  value: number;
  /** value - stake (dollars). */
  ev: number;
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
  now: ValueView;
  atPlacement: ValueView | null;
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
  full = false
): BetView {
  const v = valueBetRow(bet, legs);
  const payout = winPayout(bet, legs);
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
    sameGameEventIds: v.now.sameGameEventIds,
    legs: legs.map((l) =>
      legView(l, l.eventId ? evs.get(l.eventId) : undefined, full)
    ),
  };
}

export function betViews(db: Db, status?: BetStatus): BetView[] {
  const all = listBets(db, status);
  const evs = eventsById(
    db,
    all.flatMap((b) => b.legs)
  );
  return all.map((b) => betView(b, evs));
}

export function betViewById(db: Db, b: BetWithLegs): BetView {
  return betView(b, eventsById(db, b.legs), true);
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

export interface Portfolio {
  open: { count: number; staked: number; value: number; ev: number };
  settled: { count: number; staked: number; returned: number; profit: number };
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

export function portfolio(db: Db): Portfolio {
  const all = listBets(db);
  const views = new Map(betViews(db).map((v) => [v.id, v]));
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
  return {
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
    exposure: evs.map((e) => exposureFor(e, byEvent.get(e.id)!)),
  };
}

export function eventRow(db: Db, id: string): EventRow | undefined {
  return db.select().from(events).where(eq(events.id, id)).get();
}
