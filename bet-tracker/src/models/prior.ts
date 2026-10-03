import type {
  Market,
  PriorSource,
  SelectionKind,
  Side,
  Sport,
} from '../domain/types.js';
import { devig, devigSingle } from '../odds/math.js';
import { normalCdf, normalQuantile } from './stats.js';

// Pregame view of an event: who is favored and by how much, and how much
// scoring to expect. Every live model starts here and updates with state.

export interface Prior {
  /** Source of the win probabilities (the primary source). */
  source: PriorSource;
  homeWin: number;
  /** 0 except soccer. */
  draw: number;
  awayWin: number;
  /** Expected final margin, home minus away (football only, else null). */
  expectedMargin: number | null;
  /** Expected final total points/runs/goals (null for MMA). */
  expectedTotal: number | null;
  /** Human-readable inputs, e.g. "DraftKings via ESPN: ML -165/+330/+330". */
  detail: string;
}

export interface FootballSigmas {
  marginSigma: number;
  totalSigma: number;
}

export interface ModelParams {
  football: { nfl: FootballSigmas; ncaaf: FootballSigmas };
  mlb: { simulations: number };
}

/** League-average totals used when no source gives one. */
export const LEAGUE_AVG_TOTAL: Record<Sport, number | null> = {
  nfl: 44,
  ncaaf: 55,
  mlb: 8.8,
  soccer: 2.6,
  mma: null,
};

/** Neutral soccer split (no lean either way). */
const NEUTRAL_SOCCER_DRAW = 0.27;
/** Typical 3-way hold for stripping vig from one entered soccer price. */
const THREE_WAY_HOLD = 0.06;

export interface LinesInput {
  homeMoneyline: number | null;
  awayMoneyline: number | null;
  drawMoneyline: number | null;
  spreadHome: number | null;
  total: number | null;
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
  margin?: number;
  total?: number;
  notes: string[];
}

const isFootball = (s: Sport) => s === 'nfl' || s === 'ncaaf';
const fmt = (p: number) => (p > 0 ? `+${p}` : `${p}`);

function fromLines(
  sport: Sport,
  l: LinesInput,
  source: PriorSource,
  label: string
): Partial | null {
  const out: Partial = { source, notes: [] };
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
    }
  } else if (l.homeMoneyline != null && l.awayMoneyline != null) {
    const { fair } = devig([l.homeMoneyline, l.awayMoneyline]);
    [out.pHome, out.pAway] = fair as [number, number];
    out.notes.push(`ML ${fmt(l.homeMoneyline)}/${fmt(l.awayMoneyline)}`);
  }
  if (isFootball(sport) && l.spreadHome != null) {
    out.margin = -l.spreadHome;
    out.notes.push(`home ${fmt(l.spreadHome)}`.replace('+0', 'PK'));
  }
  if (l.total != null && sport !== 'mma') {
    out.total = l.total;
    out.notes.push(`o/u ${l.total}`);
  }
  if (out.pHome == null && out.margin == null && out.total == null) return null;
  out.notes = [`${label}: ${out.notes.join(', ')}`];
  return out;
}

function fromEntered(sport: Sport, legs: EnteredLeg[]): Partial | null {
  const out: Partial = { source: 'entered_odds', notes: [] };
  for (const leg of legs) {
    if (leg.market === 'moneyline' && leg.side) {
      const p = devigSingle(leg.price);
      out.pHome ??= leg.side === 'home' ? p : 1 - p;
      out.notes.push(`${leg.side} ML ${fmt(leg.price)}`);
    } else if (leg.market === 'moneyline3way') {
      const p = devigSingle(leg.price, THREE_WAY_HOLD);
      if (leg.selectionKind === 'draw') out.pDraw ??= p;
      else if (leg.side === 'home') out.pHome ??= p;
      else if (leg.side === 'away') out.pAway ??= p;
      out.notes.push(`${leg.side ?? 'draw'} 3-way ${fmt(leg.price)}`);
    } else if (
      leg.market === 'spread' &&
      leg.side &&
      leg.line != null &&
      isFootball(sport)
    ) {
      out.margin ??= leg.side === 'home' ? -leg.line : leg.line;
      out.notes.push(`${leg.side} ${fmt(leg.line)}`);
    } else if (leg.market === 'total' && leg.line != null) {
      out.total ??= leg.line;
      out.notes.push(`o/u ${leg.line}`);
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

/**
 * Build the prior from the first source that prices the outcome, in order:
 * ESPN lines, Odds API snapshot, entered odds, neutral. A component the
 * primary source lacks (e.g. the total) is filled from the next source that
 * has it, then from league averages; `detail` says where each came from.
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
    inputs.entered?.length ? fromEntered(sport, inputs.entered) : null,
  ].filter((s): s is Partial => s != null);

  const priced = sources.find(
    (s) => s.pHome != null || s.pDraw != null || s.margin != null
  );
  const totalSrc = sources.find((s) => s.total != null);
  const used = [priced, totalSrc].filter(
    (s, i, a): s is Partial => !!s && a.indexOf(s) === i
  );
  const notes = used.flatMap((s) => s.notes);

  const sigma = isFootball(sport)
    ? params.football[sport as 'nfl' | 'ncaaf'].marginSigma
    : 0;
  let pHome = priced?.pHome;
  let pDraw = priced?.pDraw;
  let pAway = priced?.pAway;
  let margin: number | null = isFootball(sport)
    ? (priced?.margin ?? null)
    : null;

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
    if (isFootball(sport)) {
      if (pHome == null && margin != null) pHome = normalCdf(margin / sigma);
      if (margin == null && pHome != null)
        margin = sigma * normalQuantile(pHome);
    }
    pHome ??= 0.5;
    margin ??= isFootball(sport) ? 0 : null;
    pAway = 1 - pHome;
  }

  const total = totalSrc?.total ?? LEAGUE_AVG_TOTAL[sport];
  if (!priced) notes.unshift('neutral: no pregame price');
  if (!totalSrc && total != null) notes.push(`league-average total ${total}`);

  return {
    source: priced?.source ?? 'neutral',
    homeWin: pHome,
    draw: pDraw,
    awayWin: pAway!,
    expectedMargin: margin,
    expectedTotal: total,
    detail: notes.join('; '),
  };
}
