import { nameScore, teamAliases } from '../matching/match.js';
import {
  isPinnacle,
  type NormEvent,
  type NormMarket,
  type NormOutcome,
  type NormPrice,
  type OddsProviderName,
} from './provider.js';

// check_odds output for source "oddspapi" / "both": the normalized prices of
// one or both providers, merged by event, then market + line, then outcome,
// each price labelled with its provider. Every book's two (or three) sides
// are de-vigged on their own; `consensus` is the mean of those, and `fair`
// is Pinnacle's no-vig price when Pinnacle priced every side.

const FLIP: Partial<Record<NormOutcome, NormOutcome>> = {
  home: 'away',
  away: 'home',
};

const START_GAP_MS = 3 * 3600_000;

function sameTeams(a: NormEvent, b: NormEvent): 'same' | 'swapped' | null {
  if (
    Math.abs(Date.parse(a.startTime) - Date.parse(b.startTime)) > START_GAP_MS
  )
    return null;
  const fits = (x: string, y: string) =>
    Math.min(nameScore(x, teamAliases(y)), nameScore(y, teamAliases(x))) >=
    0.85;
  if (fits(a.homeTeam, b.homeTeam) && fits(a.awayTeam, b.awayTeam))
    return 'same';
  if (fits(a.homeTeam, b.awayTeam) && fits(a.awayTeam, b.homeTeam))
    return 'swapped';
  return null;
}

/** Trust order for home/away: our ESPN event, the provider's own, participant1. */
const RANK: Record<NormEvent['homeAwayFrom'], number> = {
  espn: 0,
  provider: 1,
  participant1: 2,
};

export interface MergedEvent {
  eventId?: string;
  ids: Partial<Record<OddsProviderName, string>>;
  league: string;
  homeTeam: string;
  awayTeam: string;
  homeAwayFrom: NormEvent['homeAwayFrom'];
  startTime: string;
  prices: NormPrice[];
}

/**
 * One event per game across providers (both names, either way round, start
 * within 3 h). Prices of a provider listed the other way round are flipped
 * to the most trusted orientation (our ESPN event beats the Odds API, which
 * beats OddsPapi's participant1 guess).
 */
export function mergeEvents(lists: NormEvent[][]): MergedEvent[] {
  const all = lists
    .flat()
    .sort((a, b) => RANK[a.homeAwayFrom] - RANK[b.homeAwayFrom]);
  const out: (MergedEvent & { base: NormEvent })[] = [];
  for (const e of all) {
    let target: (typeof out)[number] | undefined;
    let how: 'same' | 'swapped' | null = null;
    for (const m of out) {
      if (m.ids[e.provider]) continue;
      how = sameTeams(m.base, e);
      if (how) {
        target = m;
        break;
      }
    }
    const prices =
      how === 'swapped'
        ? e.prices.map((p) => ({ ...p, outcome: FLIP[p.outcome] ?? p.outcome }))
        : e.prices;
    if (target) {
      target.ids[e.provider] = e.providerEventId;
      target.eventId ??= e.eventId;
      target.prices.push(...prices);
    } else
      out.push({
        base: e,
        ...(e.eventId ? { eventId: e.eventId } : {}),
        ids: { [e.provider]: e.providerEventId },
        league: e.league,
        homeTeam: e.homeTeam,
        awayTeam: e.awayTeam,
        homeAwayFrom: e.homeAwayFrom,
        startTime: e.startTime,
        prices: [...prices],
      });
  }
  return out
    .map(({ base: _base, ...m }) => m)
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
}

/** No-vig probabilities from decimal prices (proportional). */
export function noVig(decimals: number[]): { fair: number[]; hold: number } {
  const implied = decimals.map((d) => 1 / d);
  const total = implied.reduce((a, b) => a + b, 0);
  return { fair: implied.map((p) => p / total), hold: total - 1 };
}

const round4 = (x: number) => Math.round(x * 10000) / 10000;

export interface MergedBookPrice {
  provider: OddsProviderName;
  book: string;
  american: number;
  decimal: number;
  derived?: 'american' | 'decimal';
  /** This book's own de-vigged probability. */
  fair: number;
  lastUpdated: string;
}

export interface MergedOutcomeView {
  name: string;
  outcome: NormOutcome;
  /** Spreads: this side's line; totals/props: the line. */
  point?: number;
  /** Mean of the books' de-vigged probabilities. */
  consensus: number;
  /** Pinnacle's no-vig probability (present when Pinnacle priced every side). */
  fair?: number;
  /** fair as an American price. */
  fairAmerican?: number;
  best: { american: number; book: string; provider: OddsProviderName };
  books: MergedBookPrice[];
}

export interface MergedMarketView {
  market: NormMarket;
  propType?: string;
  player?: string;
  /** Spreads: the home side's line; totals/props: the line; h2h: absent. */
  line?: number;
  /** Mean overround across the books. */
  hold: number;
  outcomes: MergedOutcomeView[];
}

const ORDER: NormOutcome[] = [
  'home',
  'away',
  'draw',
  'over',
  'under',
  'yes',
  'no',
];

function groupKey(p: NormPrice): string {
  const line =
    p.line == null
      ? ''
      : p.market === 'spreads'
        ? String(p.outcome === 'away' ? -p.line : p.line)
        : String(p.line);
  return [p.market, p.propType ?? '', p.player ?? '', line].join('|');
}

/** Lines kept per game market (most-offered first); props: one per player. */
const PER_MARKET_LINES = 3;

export function mergedMarkets(e: MergedEvent): MergedMarketView[] {
  const groups = new Map<string, NormPrice[]>();
  for (const p of e.prices) {
    const k = groupKey(p);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = []));
    g.push(p);
  }
  const views: (MergedMarketView & { nBooks: number; main: boolean })[] = [];
  for (const prices of groups.values()) {
    const first = prices[0]!;
    // Per provider+book: its outcomes in this group.
    const byBook = new Map<string, NormPrice[]>();
    for (const p of prices) {
      const k = `${p.provider}|${p.book}`;
      const list = byBook.get(k) ?? [];
      // A book listed twice for one outcome: keep the newest.
      const dup = list.findIndex((x) => x.outcome === p.outcome);
      if (dup >= 0) {
        if (p.lastUpdated > list[dup]!.lastUpdated) list[dup] = p;
      } else list.push(p);
      byBook.set(k, list);
    }
    const outcomes = ORDER.filter((o) => prices.some((p) => p.outcome === o));
    if (outcomes.length < 2) continue;
    const books = [...byBook.values()].filter(
      (list) => list.length === outcomes.length
    );
    if (!books.length) continue;
    const fairs = books.map((list) => {
      const ordered = outcomes.map((o) => list.find((p) => p.outcome === o)!);
      return { list: ordered, ...noVig(ordered.map((p) => p.decimal)) };
    });
    const pin =
      fairs.find(
        (f) => isPinnacle(f.list[0]!.book) && f.list[0]!.provider === 'oddspapi'
      ) ?? fairs.find((f) => isPinnacle(f.list[0]!.book));
    const name = (o: NormOutcome) =>
      o === 'home'
        ? e.homeTeam
        : o === 'away'
          ? e.awayTeam
          : o[0]!.toUpperCase() + o.slice(1);
    const homeLine =
      first.market === 'spreads'
        ? (prices.find((p) => p.outcome === 'home')?.line ?? undefined)
        : (first.line ?? undefined);
    views.push({
      market: first.market,
      ...(first.propType ? { propType: first.propType } : {}),
      ...(first.player ? { player: first.player } : {}),
      ...(homeLine != null ? { line: homeLine } : {}),
      hold: round4(fairs.reduce((a, f) => a + f.hold, 0) / fairs.length),
      outcomes: outcomes.map((o, i) => {
        const priced = fairs.map((f) => ({ p: f.list[i]!, fair: f.fair[i]! }));
        const best = priced.reduce((a, b) =>
          b.p.decimal > a.p.decimal ? b : a
        ).p;
        const point = priced.find((x) => x.p.line != null)?.p.line;
        const pf = pin?.fair[i];
        return {
          name: name(o),
          outcome: o,
          ...(point != null ? { point } : {}),
          consensus: round4(
            priced.reduce((a, x) => a + x.fair, 0) / priced.length
          ),
          ...(pf != null
            ? {
                fair: round4(pf),
                fairAmerican:
                  pf >= 0.5
                    ? Math.round((-100 * pf) / (1 - pf))
                    : Math.round((100 * (1 - pf)) / pf),
              }
            : {}),
          best: {
            american: best.american,
            book: best.book,
            provider: best.provider,
          },
          books: priced.map(({ p, fair }) => ({
            provider: p.provider,
            book: p.book,
            american: p.american,
            decimal: p.decimal,
            ...(p.derived ? { derived: p.derived } : {}),
            fair: round4(fair),
            lastUpdated: p.lastUpdated,
          })),
        };
      }),
      nBooks: books.length,
      main: prices.some((p) => p.mainLine),
    });
  }
  const out: MergedMarketView[] = [];
  const strip = ({ nBooks: _n, main: _m, ...v }: (typeof views)[number]) => v;
  for (const market of ['h2h', 'spreads', 'totals'] as const)
    out.push(
      ...views
        .filter((v) => v.market === market)
        .sort((a, b) => Number(b.main) - Number(a.main) || b.nBooks - a.nBooks)
        .slice(0, PER_MARKET_LINES)
        .map(strip)
    );
  // Props: per player and prop type, the main (else most-offered) line.
  const props = new Map<string, (typeof views)[number]>();
  for (const v of views.filter((x) => x.market === 'player_prop')) {
    const k = `${v.player}|${v.propType}`;
    const cur = props.get(k);
    if (
      !cur ||
      Number(v.main) - Number(cur.main) > 0 ||
      (v.main === cur.main && v.nBooks > cur.nBooks)
    )
      props.set(k, v);
  }
  out.push(...[...props.values()].map(strip));
  return out;
}

export function mergedView(e: MergedEvent) {
  return {
    ...(e.eventId ? { eventId: e.eventId } : {}),
    ids: e.ids,
    commenceTime: e.startTime,
    home: e.homeTeam,
    away: e.awayTeam,
    homeAwayFrom: e.homeAwayFrom,
    markets: mergedMarkets(e),
  };
}
