import type {
  Market,
  PriorSource,
  SelectionKind,
  Side,
  Sport,
} from '../domain/types.js';
import { devig, devigSingle } from '../odds/math.js';
import { normalCdf, normalQuantile } from './stats.js';

// Pregame view of an event: who is favored and by how much, how much
// scoring to expect, and the market's fair price for each exact line it
// quotes. Every live model is fitted to the main lines here (models/fit.ts)
// and updates with game state.

/** A main line and its fair probability (excluding a push). */
export interface LineTarget {
  /** Spread: the home team's line. Total: the line. */
  line: number;
  /** Spread: P(home covers). Total: P(over). Both given no push. */
  p: number;
}

/** The market's fair probability for one exact selection (no push). */
export interface MarketPrice {
  market: Market;
  kind: SelectionKind;
  side: Side | null;
  line: number | null;
  p: number;
  source: string;
}

export interface Prior {
  /** Source of the win probabilities (the primary source). */
  source: PriorSource;
  homeWin: number;
  /** 0 except soccer. */
  draw: number;
  awayWin: number;
  /** Margin sports (NFL, NCAAF, WNBA): fitted mean final margin, home − away. */
  expectedMargin: number | null;
  /** Margin sports: fitted σ of the final margin (null = league default). */
  marginSigma?: number | null;
  /** Expected final total (fitted for margin sports; null for MMA). */
  expectedTotal: number | null;
  /** Main spread / run line / puck line and its fair price. */
  spread?: LineTarget | null;
  /** Main total and its fair price. */
  totalLine?: LineTarget | null;
  /** Exact-line fair prices for anchoring legs, best source first. */
  markets?: MarketPrice[];
  /** Sport-model parameters fitted to the main lines (models/fit.ts). */
  fit?: Record<string, number> | null;
  /** Human-readable inputs, e.g. "DraftKings via ESPN: ML -165/+330/+330". */
  detail: string;
}

export interface MarginSigmas {
  /** League-default σ of the final margin (points). */
  marginSigma: number;
  totalSigma: number;
  /** Bounds for the per-game σ fitted to the moneyline and spread. */
  sigmaRange: readonly [number, number];
}
/** @deprecated name kept for imports; same shape for every margin sport. */
export type FootballSigmas = MarginSigmas;

export interface ModelParams {
  football: { nfl: MarginSigmas; ncaaf: MarginSigmas };
  wnba: MarginSigmas;
}

/** League-average totals used when no source gives one. */
export const LEAGUE_AVG_TOTAL: Record<Sport, number | null> = {
  nfl: 44,
  ncaaf: 55,
  mlb: 8.8,
  nhl: 6.0,
  wnba: 162,
  soccer: 2.6,
  mma: null,
};

export const isMarginSport = (s: Sport): s is 'nfl' | 'ncaaf' | 'wnba' =>
  s === 'nfl' || s === 'ncaaf' || s === 'wnba';

export const marginSigmasFor = (
  sport: 'nfl' | 'ncaaf' | 'wnba',
  p: ModelParams
) => (sport === 'wnba' ? p.wnba : p.football[sport]);

/** Neutral soccer split (no lean either way). */
const NEUTRAL_SOCCER_DRAW = 0.27;
/** Typical 3-way hold for stripping vig from one entered soccer price. */
const THREE_WAY_HOLD = 0.06;

export interface LinesInput {
  homeMoneyline: number | null;
  awayMoneyline: number | null;
  drawMoneyline: number | null;
  /** Home team's spread (negative = home favored). */
  spreadHome: number | null;
  /** Prices of the two spread sides, when known. */
  spreadHomePrice?: number | null;
  spreadAwayPrice?: number | null;
  total: number | null;
  overPrice?: number | null;
  underPrice?: number | null;
}

/** A leg Dan entered on this event, used for the entered-odds prior. */
export interface EnteredLeg {
  market: Market;
  selectionKind: SelectionKind;
  side: Side | null;
  line: number | null;
  price: number;
}

interface Partial {
  source: PriorSource;
  pHome?: number;
  pDraw?: number;
  pAway?: number;
  spread?: LineTarget;
  total?: LineTarget;
  markets: MarketPrice[];
  notes: string[];
}

const fmt = (p: number) => (p > 0 ? `+${p}` : `${p}`);

function fromLines(
  sport: Sport,
  l: LinesInput,
  source: PriorSource,
  label: string
): Partial | null {
  const out: Partial = { source, markets: [], notes: [] };
  const push = (m: Omit<MarketPrice, 'source'>) =>
    out.markets.push({ ...m, source: label });
  if (sport === 'soccer') {
    if (
      l.homeMoneyline != null &&
      l.awayMoneyline != null &&
      l.drawMoneyline != null
    ) {
      const { fair } = devig([
        l.homeMoneyline,
        l.drawMoneyline,
        l.awayMoneyline,
      ]);
      [out.pHome, out.pDraw, out.pAway] = fair as [number, number, number];
      out.notes.push(
        `ML ${fmt(l.homeMoneyline)}/${fmt(l.drawMoneyline)}/${fmt(l.awayMoneyline)}`
      );
      push({
        market: 'moneyline3way',
        kind: 'team',
        side: 'home',
        line: null,
        p: out.pHome,
      });
      push({
        market: 'moneyline3way',
        kind: 'draw',
        side: null,
        line: null,
        p: out.pDraw,
      });
      push({
        market: 'moneyline3way',
        kind: 'team',
        side: 'away',
        line: null,
        p: out.pAway,
      });
    }
  } else if (l.homeMoneyline != null && l.awayMoneyline != null) {
    const { fair } = devig([l.homeMoneyline, l.awayMoneyline]);
    [out.pHome, out.pAway] = fair as [number, number];
    out.notes.push(`ML ${fmt(l.homeMoneyline)}/${fmt(l.awayMoneyline)}`);
    push({
      market: 'moneyline',
      kind: 'team',
      side: 'home',
      line: null,
      p: out.pHome,
    });
    push({
      market: 'moneyline',
      kind: 'team',
      side: 'away',
      line: null,
      p: out.pAway,
    });
  }
  const spreadPriced = l.spreadHomePrice != null && l.spreadAwayPrice != null;
  // Football/basketball spreads sit at the median (fair ~50/50 unpriced).
  // MLB run lines and NHL puck lines are fixed at ±1.5 and priced well away
  // from 50%, so they only count with prices.
  if (
    l.spreadHome != null &&
    (isMarginSport(sport) ||
      (spreadPriced && (sport === 'mlb' || sport === 'nhl')))
  ) {
    const priced = spreadPriced;
    const p = priced
      ? devig([l.spreadHomePrice!, l.spreadAwayPrice!]).fair[0]!
      : 0.5;
    out.spread = { line: l.spreadHome, p };
    out.notes.push(
      `home ${fmt(l.spreadHome)}${priced ? ` ${fmt(l.spreadHomePrice!)}/${fmt(l.spreadAwayPrice!)}` : ''}`
    );
    if (priced) {
      push({
        market: 'spread',
        kind: 'team',
        side: 'home',
        line: l.spreadHome,
        p,
      });
      push({
        market: 'spread',
        kind: 'team',
        side: 'away',
        line: -l.spreadHome,
        p: 1 - p,
      });
    }
  }
  if (l.total != null && sport !== 'mma') {
    const priced = l.overPrice != null && l.underPrice != null;
    const p = priced ? devig([l.overPrice!, l.underPrice!]).fair[0]! : 0.5;
    out.total = { line: l.total, p };
    out.notes.push(
      `o/u ${l.total}${priced ? ` ${fmt(l.overPrice!)}/${fmt(l.underPrice!)}` : ''}`
    );
    if (priced) {
      push({ market: 'total', kind: 'over', side: null, line: l.total, p });
      push({
        market: 'total',
        kind: 'under',
        side: null,
        line: l.total,
        p: 1 - p,
      });
    }
  }
  if (out.pHome == null && out.spread == null && out.total == null) return null;
  out.notes = [`${label}: ${out.notes.join(', ')}`];
  return out;
}

function fromEntered(legs: EnteredLeg[]): Partial | null {
  const out: Partial = { source: 'entered_odds', markets: [], notes: [] };
  for (const leg of legs) {
    const hold = leg.market === 'moneyline3way' ? THREE_WAY_HOLD : undefined;
    const p = devigSingle(leg.price, hold);
    out.markets.push({
      market: leg.market,
      kind: leg.selectionKind,
      side: leg.side,
      line: leg.line,
      p,
      source: `entered ${fmt(leg.price)}`,
    });
    if (leg.market === 'moneyline' && leg.side) {
      out.pHome ??= leg.side === 'home' ? p : 1 - p;
      out.notes.push(`${leg.side} ML ${fmt(leg.price)}`);
    } else if (leg.market === 'moneyline3way') {
      if (leg.selectionKind === 'draw') out.pDraw ??= p;
      else if (leg.side === 'home') out.pHome ??= p;
      else if (leg.side === 'away') out.pAway ??= p;
      out.notes.push(`${leg.side ?? 'draw'} 3-way ${fmt(leg.price)}`);
    } else if (leg.market === 'spread' && leg.side && leg.line != null) {
      // Home line and P(home covers), from either side's price.
      out.spread ??=
        leg.side === 'home'
          ? { line: leg.line, p }
          : { line: -leg.line, p: 1 - p };
      out.notes.push(`${leg.side} ${fmt(leg.line)} ${fmt(leg.price)}`);
    } else if (leg.market === 'total' && leg.line != null) {
      out.total ??= {
        line: leg.line,
        p: leg.selectionKind === 'over' ? p : 1 - p,
      };
      out.notes.push(`${leg.selectionKind} ${leg.line} ${fmt(leg.price)}`);
    }
  }
  if (out.notes.length === 0) return null;
  out.notes = [`entered odds: ${out.notes.join(', ')}`];
  return out;
}

export interface PriorInputs {
  /** Free pregame lines from the game-state provider (ESPN/DraftKings). */
  espnLines?: (LinesInput & { source?: string }) | null;
  /** The optional Odds API pregame snapshot, already reduced to lines. */
  snapshot?: LinesInput | null;
  /** Legs Dan entered on this event (placed pregame only). */
  entered?: EnteredLeg[];
}

const marketKey = (m: Pick<MarketPrice, 'market' | 'kind' | 'side' | 'line'>) =>
  `${m.market}|${m.kind}|${m.side}|${m.line}`;

/** The market's fair price for an exact selection, if any source quotes it. */
export function marketFor(
  prior: Prior,
  sel: Pick<MarketPrice, 'market' | 'kind' | 'side' | 'line'>
): MarketPrice | null {
  const key = marketKey(sel);
  return prior.markets?.find((m) => marketKey(m) === key) ?? null;
}

/**
 * Build the prior from the first source that prices the outcome, in order:
 * ESPN lines, Odds API snapshot, entered odds, neutral. Main spread and total
 * come from the first source quoting them; exact-line prices are collected
 * from every source (best first). Models are then fitted to it (fit.ts).
 */
export function resolvePrior(
  sport: Sport,
  inputs: PriorInputs,
  params: ModelParams
): Prior {
  const book = inputs.espnLines?.source?.replace(/^espn:/, '');
  const sources = [
    inputs.espnLines
      ? fromLines(
          sport,
          inputs.espnLines,
          'espn_lines',
          book ? `${book} via ESPN` : 'ESPN'
        )
      : null,
    inputs.snapshot
      ? fromLines(
          sport,
          inputs.snapshot,
          'pregame_snapshot',
          'Odds API snapshot'
        )
      : null,
    inputs.entered?.length ? fromEntered(inputs.entered) : null,
  ].filter((s): s is Partial => s != null);

  const priced = sources.find((s) => s.pHome != null || s.pDraw != null);
  const spreadSrc = sources.find((s) => s.spread != null);
  const totalSrc = sources.find((s) => s.total != null);
  const used = [priced ?? spreadSrc, spreadSrc, totalSrc].filter(
    (s, i, a): s is Partial => !!s && a.indexOf(s) === i
  );
  const notes = used.flatMap((s) => s.notes);

  const seen = new Set<string>();
  const markets = sources
    .flatMap((s) => s.markets)
    .filter((m) => {
      const k = marketKey(m);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

  let pHome = priced?.pHome;
  let pDraw = priced?.pDraw;
  let pAway = priced?.pAway;
  const spread = spreadSrc?.spread ?? null;
  let margin: number | null = null;

  if (sport === 'soccer') {
    // Fill a partial 3-way from what is known, then renormalize.
    if (pHome == null && pAway == null) {
      pDraw ??= NEUTRAL_SOCCER_DRAW;
      pHome = pAway = (1 - pDraw) / 2;
    } else {
      pDraw ??= NEUTRAL_SOCCER_DRAW;
      if (pHome == null) pHome = Math.max(0.01, 1 - pDraw - pAway!);
      if (pAway == null) pAway = Math.max(0.01, 1 - pDraw - pHome);
    }
    const sum = pHome + pDraw + pAway;
    pHome /= sum;
    pDraw /= sum;
    pAway /= sum;
  } else {
    pDraw = 0;
    if (isMarginSport(sport)) {
      // Starting point for the fit: the spread's implied margin, or the
      // moneyline's at the league σ.
      const sigma = marginSigmasFor(sport, params).marginSigma;
      if (spread) margin = -spread.line;
      if (pHome == null && margin != null) pHome = normalCdf(margin / sigma);
      if (margin == null && pHome != null)
        margin = sigma * normalQuantile(pHome);
      margin ??= 0;
    }
    pHome ??= 0.5;
    pAway = 1 - pHome;
  }

  const totalLine = totalSrc?.total ?? null;
  const expectedTotal = totalLine?.line ?? LEAGUE_AVG_TOTAL[sport];
  if (!priced && !spreadSrc) notes.unshift('neutral: no pregame price');
  if (!totalSrc && expectedTotal != null)
    notes.push(`league-average total ${expectedTotal}`);

  return {
    source: priced?.source ?? spreadSrc?.source ?? 'neutral',
    homeWin: pHome,
    draw: pDraw,
    awayWin: pAway!,
    expectedMargin: margin,
    marginSigma: null,
    expectedTotal,
    spread,
    totalLine,
    markets,
    fit: null,
    detail: notes.join('; '),
  };
}
