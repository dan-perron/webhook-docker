import type { BetRow, EventRow, LegRow } from '../db/schema.js';
import { valueBet } from '../domain/value.js';
import { isMarginSport } from '../models/prior.js';
import type { Outcome } from '../models/types.js';
import { sidesSwapped, type EventOdds } from '../odds/consensus.js';
import { americanToDecimal, decimalToAmerican } from '../odds/math.js';
import type { OddsMarket, Quota } from '../odds/oddsApi.js';

// Closing line value: the market's de-vigged P(win) just before the game, next
// to the one at placement, to judge a pick apart from its result. Closes use
// the same cross-book consensus as check_odds. The bet-level numbers are
// computed on read (like atPlacement), so a corrected payout carries through.

export const CLOSE_SOURCES = [
  'exact',
  'interpolated',
  'unsupported',
  'missed',
  'live',
] as const;
export type CloseSource = (typeof CLOSE_SOURCES)[number];

export interface LegClose {
  /** P(win), not conditional on a push: comparable with pWinPlacement. */
  p: number | null;
  /** Consensus fair American price at the line below. */
  price: number | null;
  /** The closing line, from the selection's side. */
  line: number | null;
  source: CloseSource;
  /** When the odds were read (historical: the snapshot's own timestamp). */
  snapshotAt: string;
  /**
   * De-vigged consensus P(win | no push) at `line`: the fair price the
   * placed price is measured against. Absent on closes from before it.
   */
  fair?: number | null;
  /**
   * The bet's own book at close, as offered (vig in), on the leg's own line;
   * null when that book didn't list it.
   */
  book?: { key: string; price: number } | null;
  /** 'snapshot' = pregame call; 'historical' = Odds API historical odds. */
  via?: 'snapshot' | 'historical';
}

export const unavailableClose = (
  source: CloseSource,
  at: string
): LegClose => ({ p: null, price: null, line: null, source, snapshotAt: at });

/**
 * Odds API bookmaker key for a book as entered ("FanDuel", "fanduel",
 * "Caesars"); null for books the API doesn't carry (Circa, Kalshi).
 */
export function bookKeyFor(book: string): string | null {
  const k = book.toLowerCase().replace(/[^a-z0-9]/g, '');
  const keys: Record<string, string> = {
    fanduel: 'fanduel',
    fd: 'fanduel',
    draftkings: 'draftkings',
    dk: 'draftkings',
    betmgm: 'betmgm',
    mgm: 'betmgm',
    caesars: 'williamhill_us',
    williamhill: 'williamhill_us',
    betrivers: 'betrivers',
    espnbet: 'espnbet',
    thescorebet: 'espnbet',
    fanatics: 'fanatics',
    hardrock: 'hardrockbet',
    hardrockbet: 'hardrockbet',
    ballybet: 'ballybet',
    bovada: 'bovada',
    betonline: 'betonlineag',
    mybookie: 'mybookieag',
    lowvig: 'lowvig',
    betus: 'betus',
    fliff: 'fliff',
  };
  return keys[k] ?? null;
}

export const parseClose = (l: LegRow): LegClose | null =>
  l.closeJson ? (JSON.parse(l.closeJson) as LegClose) : null;

/** The Odds API market pricing a leg; null when there is none to fetch. */
export function closeMarket(
  l: Pick<LegRow, 'market' | 'sport'>
): OddsMarket | null {
  switch (l.market) {
    case 'moneyline':
      // Soccer's h2h is 3-way: it doesn't price a 2-way moneyline.
      return l.sport === 'soccer' ? null : 'h2h';
    case 'moneyline3way':
      return 'h2h';
    case 'spread':
      return 'spreads';
    case 'total':
      return 'totals';
    default:
      return null; // player props, series markets
  }
}

export interface CloseCandidate<T> {
  /** Odds API sport key. */
  key: string;
  start: number;
  market: OddsMarket;
  item: T;
}

export interface CloseWindow<T> {
  key: string;
  /** The earliest start: the snapshot is timed to it. */
  start: number;
  /** Only the markets its legs need (cost = markets x regions). */
  markets: OddsMarket[];
  items: T[];
}

/** Group by sport, then by starts within `windowMs` of each group's first. */
export function closeWindows<T>(
  candidates: CloseCandidate<T>[],
  windowMs: number
): CloseWindow<T>[] {
  const out: CloseWindow<T>[] = [];
  const open = new Map<string, CloseWindow<T>>();
  for (const c of [...candidates].sort((a, b) => a.start - b.start)) {
    let w = open.get(c.key);
    if (!w || c.start - w.start > windowMs) {
      w = { key: c.key, start: c.start, markets: [], items: [] };
      open.set(c.key, w);
      out.push(w);
    }
    if (!w.markets.includes(c.market)) w.markets.push(c.market);
    w.items.push(c.item);
  }
  return out;
}

/**
 * Stop below the floor, but only on a reading from this month: the quota
 * resets on the 1st, and nothing refreshes a reading if we stop calling.
 */
export function quotaBelowFloor(q: Quota, floor: number, now: Date): boolean {
  return (
    q.remaining != null &&
    q.remaining < floor &&
    q.updatedAt?.slice(0, 7) === now.toISOString().slice(0, 7)
  );
}

/**
 * A leg's close from one event's consensus: its exact line, else (margin
 * sports) `interpolate` from the model fitted to the closing lines. The
 * market's price is P(win) given no push, while placement's is not, so it is
 * scaled by the leg's P(push) at placement.
 */
export function closeFromOdds(
  leg: LegRow,
  e: Pick<EventRow, 'homeName' | 'sport'>,
  odds: EventOdds,
  at: string,
  interpolate: (leg: LegRow, odds: EventOdds) => Outcome,
  opts: { bookKey?: string | null; via?: LegClose['via'] } = {}
): LegClose {
  const via = opts.via ?? 'snapshot';
  const market = closeMarket(leg);
  const none = unavailableClose('unsupported', at);
  if (!market) return none;
  const backsApiHome = (leg.side === 'home') !== sidesSwapped(e.homeName, odds);
  const name =
    leg.selectionKind === 'over'
      ? 'Over'
      : leg.selectionKind === 'under'
        ? 'Under'
        : leg.selectionKind === 'draw'
          ? 'Draw'
          : !leg.side
            ? null
            : backsApiHome
              ? odds.home
              : odds.away;
  if (!name) return none;

  const lines = odds.markets.filter((m) => m.market === market);
  const fromHome = (point: number) => (backsApiHome ? point : -point);
  const point =
    market === 'h2h'
      ? null
      : leg.line == null
        ? undefined
        : market === 'spreads'
          ? fromHome(leg.line)
          : leg.line;
  if (point === undefined) return none;

  const exact = lines.find((m) => m.point === point);
  const fair = exact?.consensus[name];
  if (fair != null) {
    if (!(fair > 0 && fair < 1)) return none;
    const own = opts.bookKey
      ? exact!.books.find((b) => b.book === opts.bookKey)?.prices[name]
      : undefined;
    return {
      p: fair * (1 - (leg.pPushPlacement ?? 0)),
      price: decimalToAmerican(1 / fair),
      line: leg.line,
      source: 'exact',
      snapshotAt: at,
      fair,
      book: own != null ? { key: opts.bookKey!, price: own } : null,
      via,
    };
  }
  // Off the closing line. Lines are sorted most-offered first.
  const main = lines[0];
  if (market === 'h2h' || main?.point == null || !isMarginSport(e.sport))
    return none;
  const { win, push } = interpolate(leg, odds);
  if (!(win > 0 && win < 1)) return none;
  return {
    p: win,
    price: decimalToAmerican(1 / win),
    line: market === 'spreads' ? fromHome(main.point) : main.point,
    source: 'interpolated',
    snapshotAt: at,
    fair: push < 1 ? win / (1 - push) : null,
    // No book listed this line (else it would be exact).
    book: null,
    via,
  };
}

/**
 * The close's fair P(win | no push). Closes from before `fair` was stored:
 * exact = p / (1 - P(push) at placement), interpolated = p.
 */
export function closeFair(l: LegRow, c: LegClose | null): number | null {
  if (c?.p == null) return null;
  if (c.fair !== undefined) return c.fair;
  const push = c.source === 'exact' ? (l.pPushPlacement ?? 0) : 0;
  return push < 1 ? c.p / (1 - push) : null;
}

/**
 * Price CLV: the leg's placed price at the de-vigged closing fair, i.e. its
 * EV per unit staked at the close, ignoring pushes (both sides are
 * conditional on no push): fair x decimal(placed) - 1. Positive = beat the
 * close. Parlay legs use their own leg price.
 */
export function legPriceClv(l: LegRow): number | null {
  const fair = closeFair(l, parseClose(l));
  return fair == null ? null : fair * americanToDecimal(l.priceAmerican) - 1;
}

/**
 * Price movement around placement, as decimal-odds ratios (positive = the
 * price Dan got was better): recToPlaced = placed / recommended - 1,
 * placedToClose = placed / the book's own closing price - 1.
 */
export function legPriceMove(l: LegRow): {
  recToPlaced: number | null;
  placedToClose: number | null;
} {
  const placed = americanToDecimal(l.priceAmerican);
  const bookClose = parseClose(l)?.book?.price;
  return {
    recToPlaced:
      l.recommendedPrice != null
        ? placed / americanToDecimal(l.recommendedPrice) - 1
        : null,
    placedToClose:
      bookClose != null ? placed / americanToDecimal(bookClose) - 1 : null,
  };
}

/** clv = pClose - pPlacement (probability points; positive = beat the close). */
export function legClv(l: LegRow): { clv: number; clvPct: number } | null {
  const p = parseClose(l)?.p;
  if (p == null || !l.pWinPlacement) return null;
  return { clv: p - l.pWinPlacement, clvPct: p / l.pWinPlacement - 1 };
}

export interface BetClose {
  /** Null while legs are still waiting for their close. */
  atClose: {
    pWin: number | null;
    /** Cents. */
    valueCents: number | null;
    evCents: number | null;
    source: CloseSource;
  } | null;
  /** pWinClose / pWinAtPlacement - 1. */
  clv: number | null;
}

/**
 * pWin = the product of the legs' closes (legs are independent: any same-game
 * legs make the bet unsupported). Value and EV use the stated payout, so the
 * boost counts, and refund pushes at placement's P(push), the same way
 * atPlacement does. clv compares like with like: both sides are the product
 * of the legs' P(win), which excludes parlay paths where a leg pushes.
 */
export function betClose(bet: BetRow, legRows: LegRow[]): BetClose {
  const blocked = (source: CloseSource): BetClose => ({
    atClose: { pWin: null, valueCents: null, evCents: null, source },
    clv: null,
  });
  if (bet.placedLive) return blocked('live');
  const ids = legRows.flatMap((l) => (l.eventId ? [l.eventId] : []));
  if (new Set(ids).size < ids.length) return blocked('unsupported');
  const closes = legRows.map(parseClose);
  for (const source of ['unsupported', 'missed', 'live'] as const)
    if (closes.some((c) => c?.source === source)) return blocked(source);
  if (closes.some((c) => c?.p == null)) return { atClose: null, clv: null };

  const v = valueBet(
    bet,
    legRows.map((l, i) => ({
      priceAmerican: l.priceAmerican,
      status: 'open' as const,
      outcome: { win: closes[i]!.p!, push: l.pPushPlacement ?? 0 },
      eventId: l.eventId ?? l.seriesId,
    }))
  );
  const pWin = closes.reduce((a, c) => a * c!.p!, 1);
  const placed = legRows.reduce<number | null>(
    (a, l) => (a == null || !l.pWinPlacement ? null : a * l.pWinPlacement),
    1
  );
  return {
    atClose: {
      pWin,
      valueCents: v.valueCents,
      evCents: v.evCents,
      source: closes.some((c) => c!.source === 'interpolated')
        ? 'interpolated'
        : 'exact',
    },
    clv: placed ? pWin / placed - 1 : null,
  };
}
