import { decimalToAmerican } from './math.js';
import { noVig } from './merge.js';
import {
  parseTime,
  type PapiEntry,
  type PapiFixture,
  type PapiHistorical,
} from './oddsPapi.js';
import { defKey, type PapiMarketDef } from './papiLookups.js';
import { papiBookKey, type NormOutcome } from './provider.js';

// get_historical_odds: one settled fixture's price history per book for one
// market, read at the moments that matter for line timing: the open (first
// price), the close (last price at or before the start) and, for a bet, the
// moment it was placed. OddsPapi's history carries decimal prices only, so
// the American prices here are derived from them.

export type HistoryMarket = 'h2h' | 'spreads' | 'totals';

export interface PricePoint {
  at: string;
  decimal: number;
  /** Derived from decimal (the history has no American price). */
  american: number;
  /** Implied probability, with the vig. */
  implied: number;
}

export interface OutcomeHistory {
  name: string;
  outcome: NormOutcome;
  /** Spreads: this side's line; totals: the line. */
  point?: number;
  open: PricePoint | null;
  close: PricePoint | null;
  /** Present when asked about a bet: the last price at or before it. */
  atBet?: PricePoint | null;
  /** Every change (only with includeHistory; at most 200, newest kept). */
  history?: PricePoint[];
}

export interface BookHistory {
  book: string;
  /** Spreads: the home side's line; totals: the line. */
  line?: number;
  /** No-vig probabilities at the close, per outcome. */
  fairClose?: Record<string, number>;
  outcomes: OutcomeHistory[];
}

const point = (e: { createdAt: string; price: number }): PricePoint => ({
  at: new Date(parseTime(e.createdAt)).toISOString(),
  decimal: e.price,
  american: decimalToAmerican(e.price),
  implied: Math.round((1 / e.price) * 10000) / 10000,
});

const usable = (entries: PapiEntry[] | undefined) =>
  (entries ?? [])
    .filter((x) => x.active !== false && x.price > 1)
    .sort((a, b) => parseTime(a.createdAt) - parseTime(b.createdAt));

/** The last usable entry at or before t. */
function asOf(entries: PapiEntry[], t: number): PapiEntry | undefined {
  let hit: PapiEntry | undefined;
  for (const x of entries) if (parseTime(x.createdAt) <= t) hit = x;
  return hit;
}

export interface HistoryRequest {
  fixture: PapiFixture;
  homeIsFirst: boolean;
  sportId: number;
  market: HistoryMarket;
  /**
   * Spreads: the home side's line; totals: the line. Omitted: each book's
   * main line at the close (its two prices closest to even).
   */
  line?: number;
  /** ISO time of the bet, for atBet. */
  betAt?: string;
  includeHistory?: boolean;
}

export function summarizeHistory(
  hist: PapiHistorical,
  catalog: Map<string, PapiMarketDef>,
  req: HistoryRequest
): BookHistory[] {
  const start = parseTime(req.fixture.startTime);
  const betAt = req.betAt ? Date.parse(req.betAt) : undefined;
  const [home, away] = req.homeIsFirst
    ? [req.fixture.participant1Name, req.fixture.participant2Name]
    : [req.fixture.participant2Name, req.fixture.participant1Name];
  const out: BookHistory[] = [];
  for (const [slug, b] of Object.entries(hist.bookmakers ?? {})) {
    let best:
      | {
          def: PapiMarketDef;
          sides: [PapiEntry[], PapiEntry[]];
          gap: number;
        }
      | undefined;
    for (const [marketId, m] of Object.entries(b.markets ?? {})) {
      const def = catalog.get(defKey(req.sportId, marketId));
      if (!def || def.market !== req.market) continue;
      const sides = def.outcomes.map((o) =>
        usable(m.outcomes?.[String(o.id)]?.players?.['0'])
      ) as [PapiEntry[], PapiEntry[]];
      // participant1's handicap -> the home side's line.
      const homeLine =
        def.market === 'spreads'
          ? req.homeIsFirst
            ? def.handicap
            : -def.handicap
          : def.handicap;
      if (req.line != null && def.market !== 'h2h' && homeLine !== req.line)
        continue;
      const c0 = asOf(sides[0], start);
      const c1 = asOf(sides[1], start);
      if (!c0 || !c1) continue;
      const gap = Math.abs(1 / c0.price - 1 / c1.price);
      if (!best || gap < best.gap) best = { def, sides, gap };
    }
    if (!best) continue;
    const { def, sides } = best;
    const homeLine =
      def.market === 'spreads'
        ? req.homeIsFirst
          ? def.handicap
          : -def.handicap
        : def.handicap;
    const outcomes: OutcomeHistory[] = def.outcomes.map((o, i) => {
      const entries = sides[i]!;
      const first = o.name === '1';
      const isHome = def.market !== 'totals' && first === req.homeIsFirst;
      const outcome: NormOutcome =
        def.market === 'totals'
          ? (o.name.toLowerCase() as NormOutcome)
          : isHome
            ? 'home'
            : 'away';
      const own =
        def.market === 'spreads'
          ? first
            ? def.handicap
            : -def.handicap
          : def.market === 'totals'
            ? def.handicap
            : undefined;
      const open = entries[0];
      const close = asOf(entries, start);
      return {
        name: def.market === 'totals' ? o.name : isHome ? home : away,
        outcome,
        ...(own != null ? { point: own } : {}),
        open: open ? point(open) : null,
        close: close ? point(close) : null,
        ...(betAt != null
          ? {
              atBet: (() => {
                const x = asOf(entries, betAt);
                return x ? point(x) : null;
              })(),
            }
          : {}),
        ...(req.includeHistory
          ? { history: entries.slice(-200).map(point) }
          : {}),
      };
    });
    const closes = outcomes.map((o) => o.close?.decimal);
    const fairClose = closes.every((d): d is number => d != null)
      ? Object.fromEntries(
          noVig(closes).fair.map((p, i) => [
            outcomes[i]!.name,
            Math.round(p * 10000) / 10000,
          ])
        )
      : undefined;
    // Home first, like check_odds.
    if (outcomes[0]!.outcome === 'away') outcomes.reverse();
    out.push({
      book: papiBookKey(slug),
      ...(def.market !== 'h2h' ? { line: homeLine } : {}),
      ...(fairClose ? { fairClose } : {}),
      outcomes,
    });
  }
  return out;
}
