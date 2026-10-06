import { nameScore, teamAliases } from '../matching/match.js';
import type { LinesInput } from '../models/prior.js';
import { decimalToAmerican, devig } from './math.js';
import type { OddsEvent, OddsMarket } from './oddsApi.js';

// Turn raw Odds API events into per-book fair (de-vigged) probabilities,
// hold, and a cross-book consensus.

export interface BookLine {
  book: string;
  title: string;
  lastUpdate: string;
  /** American odds per outcome name, as offered. */
  prices: Record<string, number>;
  /** De-vigged probability per outcome name. */
  fair: Record<string, number>;
  /** Overround, e.g. 0.045 = 4.5%. */
  hold: number;
}

export interface MarketLine {
  market: OddsMarket;
  /** Spreads: the home team's point. Totals: the line. h2h: null. */
  point: number | null;
  books: BookLine[];
  /** Mean fair probability per outcome across these books. */
  consensus: Record<string, number>;
  bestPrice: Record<string, { price: number; book: string }>;
}

export interface EventOdds {
  id: string;
  commenceTime: string;
  home: string;
  away: string;
  /** Per market, one entry per distinct line, most-offered first. */
  markets: MarketLine[];
}

const PER_MARKET_LINES = 3;

export function summarizeEvent(e: OddsEvent): EventOdds {
  const groups = new Map<string, MarketLine>();
  for (const b of e.bookmakers) {
    for (const m of b.markets) {
      const market = m.key as OddsMarket;
      if (m.outcomes.length < 2) continue;
      const homeOutcome = m.outcomes.find((o) => o.name === e.home_team);
      const point =
        market === 'spreads'
          ? (homeOutcome?.point ?? null)
          : market === 'totals'
            ? (m.outcomes[0]!.point ?? null)
            : null;
      const key = `${market}|${point}`;
      let g = groups.get(key);
      if (!g) {
        g = { market, point, books: [], consensus: {}, bestPrice: {} };
        groups.set(key, g);
      }
      const { fair, hold } = devig(m.outcomes.map((o) => o.price));
      g.books.push({
        book: b.key,
        title: b.title,
        lastUpdate: m.last_update ?? b.last_update,
        prices: Object.fromEntries(m.outcomes.map((o) => [o.name, o.price])),
        fair: Object.fromEntries(m.outcomes.map((o, i) => [o.name, fair[i]!])),
        hold,
      });
    }
  }
  for (const g of groups.values()) {
    const names = Object.keys(g.books[0]!.fair);
    for (const n of names) {
      const ps = g.books
        .map((b) => b.fair[n])
        .filter((p): p is number => p != null);
      g.consensus[n] = ps.reduce((a, b) => a + b, 0) / ps.length;
      for (const b of g.books) {
        const price = b.prices[n];
        if (
          price != null &&
          (!g.bestPrice[n] || price > g.bestPrice[n].price)
        ) {
          g.bestPrice[n] = { price, book: b.title };
        }
      }
    }
  }
  const markets: MarketLine[] = [];
  for (const market of ['h2h', 'spreads', 'totals'] as const) {
    markets.push(
      ...[...groups.values()]
        .filter((g) => g.market === market)
        .sort((a, b) => b.books.length - a.books.length)
        .slice(0, PER_MARKET_LINES)
    );
  }
  return {
    id: e.id,
    commenceTime: e.commence_time,
    home: e.home_team,
    away: e.away_team,
    markets,
  };
}

/**
 * Keep events matching a free-text query: "Rams", "Rams @ Eagles",
 * "Portugal v Norway". Every named team must match one side.
 */
export function filterEvents(events: OddsEvent[], query?: string): OddsEvent[] {
  if (!query?.trim()) return events;
  const parts = query
    .split(/\s+(?:vs\.?|v\.?|@|at)\s+|\s*\/\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
  return events.filter((e) =>
    parts.every(
      (p) =>
        Math.max(
          nameScore(p, teamAliases(e.home_team)),
          nameScore(p, teamAliases(e.away_team))
        ) >= 0.85
    )
  );
}

/** A probability as a vig-free American price. */
const fairPrice = (p: number) => decimalToAmerican(1 / p);

/**
 * Reduce an event to prior lines from the cross-book consensus of the most
 * widely offered line in each market (prices are vig-free).
 */
export function linesFromOdds(e: EventOdds): LinesInput {
  const main = (m: OddsMarket) => e.markets.find((x) => x.market === m);
  const h2h = main('h2h')?.consensus;
  const draw = h2h ? (h2h['Draw'] ?? null) : null;
  const spreads = main('spreads');
  const totals = main('totals');
  const price = (p: number | undefined) =>
    p != null && p > 0 && p < 1 ? fairPrice(p) : null;
  return {
    homeMoneyline: h2h?.[e.home] != null ? fairPrice(h2h[e.home]!) : null,
    awayMoneyline: h2h?.[e.away] != null ? fairPrice(h2h[e.away]!) : null,
    drawMoneyline: draw != null ? fairPrice(draw) : null,
    spreadHome: spreads?.point ?? null,
    spreadHomePrice: price(spreads?.consensus[e.home]),
    spreadAwayPrice: price(spreads?.consensus[e.away]),
    total: totals?.point ?? null,
    overPrice: price(totals?.consensus['Over']),
    underPrice: price(totals?.consensus['Under']),
  };
}
