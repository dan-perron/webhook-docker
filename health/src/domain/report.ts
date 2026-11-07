import { addDays, daysBetween } from '../util/date.js';
import type { DayLog, Experiment, Flare } from './types.js';

// Pure: the flare report from flares, day logs and experiments.

export interface Lookback {
  /** Days before the flare to show, inclusive (default 1..3). */
  minDays: number;
  maxDays: number;
}
export const DEFAULT_LOOKBACK: Lookback = { minDays: 1, maxDays: 3 };

export interface LookbackDay {
  date: string;
  daysBefore: number;
  /** null: nothing logged for that day. */
  day: DayLog | null;
}

/** The day logs `minDays`..`maxDays` before `date`, nearest first. */
export function lookbackDays(
  date: string,
  days: Map<string, DayLog>,
  { minDays, maxDays }: Lookback
): LookbackDay[] {
  const out: LookbackDay[] = [];
  for (let n = minDays; n <= maxDays; n++) {
    const d = addDays(date, -n);
    out.push({ date: d, daysBefore: n, day: days.get(d) ?? null });
  }
  return out;
}

export interface WindowStats {
  from: string;
  to: string;
  days: number;
  /** Flare entries in the window. */
  flares: number;
  /** Sum of their counts (e.g. sores). */
  count: number;
  flaresPerWeek: number;
  countPerWeek: number;
}

const perWeek = (n: number, days: number) =>
  Math.round(((n * 7) / days) * 100) / 100;

/** Flares dated from..to inclusive, as totals and per-week rates. */
export function windowStats(
  from: string,
  to: string,
  flares: Flare[]
): WindowStats {
  const days = daysBetween(from, to) + 1;
  const inside = flares.filter((f) => f.date >= from && f.date <= to);
  const count = inside.reduce((s, f) => s + f.count, 0);
  return {
    from,
    to,
    days,
    flares: inside.length,
    count,
    flaresPerWeek: perWeek(inside.length, days),
    countPerWeek: perWeek(count, days),
  };
}

export const experimentOverlaps = (
  a: { start: string; end?: string },
  from: string,
  to: string
) => a.start <= to && (a.end ?? '9999-12-31') >= from;

export interface ExperimentComparison {
  id: string;
  name: string;
  rule: string;
  start: string;
  end: string | null;
  ongoing: boolean;
  /** From the start through its end (or today, if sooner). */
  during: WindowStats | null;
  /** The same number of days just before the start. */
  before: WindowStats | null;
  /** Other experiments overlapping the before window: a muddied baseline. */
  beforeOverlaps: string[];
}

/** Flare rate during an experiment vs. the same-length period before it. */
export function compareExperiment(
  exp: Experiment,
  others: Experiment[],
  flares: Flare[],
  today: string
): ExperimentComparison {
  const to = exp.end && exp.end < today ? exp.end : today;
  const started = exp.start <= to;
  const during = started ? windowStats(exp.start, to, flares) : null;
  const before = during
    ? windowStats(
        addDays(exp.start, -during.days),
        addDays(exp.start, -1),
        flares
      )
    : null;
  return {
    id: exp._id,
    name: exp.name,
    rule: exp.rule,
    start: exp.start,
    end: exp.end ?? null,
    ongoing: !exp.end || exp.end >= today,
    during,
    before,
    beforeOverlaps: before
      ? others
          .filter(
            (o) => o._id !== exp._id && experimentOverlaps(o, before.from, before.to)
          )
          .map((o) => o.name)
      : [],
  };
}

/** The earliest date any comparison needs flares from. */
export function comparisonStart(exps: Experiment[], today: string) {
  let first: string | undefined;
  for (const e of exps) {
    const to = e.end && e.end < today ? e.end : today;
    if (e.start > to) continue;
    const from = addDays(e.start, -(daysBetween(e.start, to) + 1));
    if (!first || from < first) first = from;
  }
  return first;
}

