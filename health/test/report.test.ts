import { describe, expect, it } from 'vitest';
import {
  compareExperiment,
  comparisonStart,
  lookbackDays,
  windowStats,
} from '../src/domain/report.js';
import type { DayLog, Experiment, Flare } from '../src/domain/types.js';

const at = new Date(0);
const flare = (date: string, count = 1): Flare => ({
  _id: date,
  date,
  issue: 'canker_sore',
  count,
  createdAt: at,
  updatedAt: at,
});
const exp = (name: string, start: string, end?: string): Experiment => ({
  _id: name,
  name,
  issue: 'canker_sore',
  rule: name,
  start,
  end,
  createdAt: at,
  updatedAt: at,
});

describe('windowStats', () => {
  it('counts flares and their counts per week, inclusive of both ends', () => {
    const s = windowStats('2026-10-01', '2026-10-10', [
      flare('2026-09-30'),
      flare('2026-10-01', 3),
      flare('2026-10-10'),
      flare('2026-10-11'),
    ]);
    // 2 flares, 4 sores over 10 days: 1.4 and 2.8 a week.
    expect(s).toEqual({
      from: '2026-10-01',
      to: '2026-10-10',
      days: 10,
      flares: 2,
      count: 4,
      flaresPerWeek: 1.4,
      countPerWeek: 2.8,
    });
  });
});

describe('compareExperiment', () => {
  it('an ended experiment: its own length, and the same length before it', () => {
    const e = exp('a', '2026-10-08', '2026-10-14');
    const c = compareExperiment(
      e,
      [e, exp('b', '2026-09-20', '2026-10-02')],
      [flare('2026-10-01'), flare('2026-10-03'), flare('2026-10-15')],
      '2026-11-07'
    );
    expect(c.ongoing).toBe(false);
    expect(c.during).toMatchObject({
      from: '2026-10-08',
      to: '2026-10-14',
      days: 7,
      flares: 0,
    });
    expect(c.before).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-07',
      days: 7,
      flares: 2,
      flaresPerWeek: 2,
    });
    expect(c.beforeOverlaps).toEqual(['b']);
  });

  it('one not started yet has no windows', () => {
    const c = compareExperiment(exp('a', '2026-12-01'), [], [], '2026-11-07');
    expect([c.during, c.before, c.ongoing]).toEqual([null, null, true]);
  });

  it('comparisonStart is the earliest before-window start', () => {
    expect(
      comparisonStart(
        [exp('a', '2026-10-08', '2026-10-14'), exp('b', '2026-11-01')],
        '2026-11-07'
      )
    ).toBe('2026-10-01');
  });
});

describe('lookbackDays', () => {
  it('lists each day in the window, nearest first, null when not logged', () => {
    const day = { _id: '2026-11-05', date: '2026-11-05' } as DayLog;
    expect(
      lookbackDays('2026-11-07', new Map([[day.date, day]]), {
        minDays: 1,
        maxDays: 3,
      })
    ).toEqual([
      { date: '2026-11-06', daysBefore: 1, day: null },
      { date: '2026-11-05', daysBefore: 2, day },
      { date: '2026-11-04', daysBefore: 3, day: null },
    ]);
  });
});
