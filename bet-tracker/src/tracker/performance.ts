import type { Db } from '../db/client.js';
import { localDate } from '../util/date.js';
import {
  filteredBetViews,
  type BetView,
  type PortfolioFilter,
} from './views.js';

// Cumulative realized profit vs. EV at placement over settled bets, by
// settlement day: the bets page chart and the performance_series tool.

/** 1 unit = $10 (the chart's default axis). */
export const UNIT_DOLLARS = 10;

export interface PerformancePoint {
  /** Settlement day, YYYY-MM-DD in the series' time zone. */
  date: string;
  /** Cumulative profit through the end of this day (dollars). */
  actual: number;
  /** Cumulative EV at placement through the end of this day (dollars). */
  expected: number;
  /** Bets settled on this day. */
  betsSettled: number;
}

export interface PerformanceSeries {
  filter: PortfolioFilter;
  timeZone: string;
  unitDollars: number;
  /** Bets in the series (won, lost, push). */
  count: number;
  /** Settled bets left out: void, or no settlement time. */
  excluded: { void: number; noSettledAt: number };
  points: PerformancePoint[];
}

const SETTLED = new Set(['won', 'lost', 'push']);

/** Profit: returned - cash stake (won: payout, push: stake back, lost: 0). */
export function betProfit(v: BetView): number {
  const returned =
    v.status === 'won' ? v.payout : v.status === 'push' ? v.cashStake : 0;
  return returned - v.cashStake;
}

export function performanceSeries(
  db: Db,
  filter: PortfolioFilter = {},
  timeZone = 'America/Chicago'
): PerformanceSeries {
  const views = filteredBetViews(db, filter);
  let voided = 0;
  let noSettledAt = 0;
  const bets = views.filter((v) => {
    if (v.status === 'void') voided++;
    if (!SETTLED.has(v.status)) return false;
    if (!v.settledAt) {
      noSettledAt++;
      return false;
    }
    return true;
  });
  bets.sort((a, b) => a.settledAt!.localeCompare(b.settledAt!));
  // In cents, so the running totals don't drift.
  const cents = (x: number) => Math.round(x * 100);
  const points: PerformancePoint[] = [];
  let actual = 0;
  let expected = 0;
  for (const v of bets) {
    actual += cents(betProfit(v));
    expected += cents(v.atPlacement?.ev ?? 0);
    const date = localDate(v.settledAt!, timeZone);
    const last = points.at(-1);
    if (last?.date === date) {
      last.actual = actual / 100;
      last.expected = expected / 100;
      last.betsSettled++;
    } else
      points.push({
        date,
        actual: actual / 100,
        expected: expected / 100,
        betsSettled: 1,
      });
  }
  return {
    filter,
    timeZone,
    unitDollars: UNIT_DOLLARS,
    count: bets.length,
    excluded: { void: voided, noSettledAt },
    points,
  };
}
