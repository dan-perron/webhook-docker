import { describe, expect, it } from 'vitest';
import { resolvePrior } from '../src/models/prior.js';
import { normalQuantile } from '../src/models/stats.js';
import { PARAMS } from './helpers/states.js';

const RAMS_LINES = {
  source: 'espn:DraftKings',
  homeMoneyline: 154,
  awayMoneyline: -185,
  drawMoneyline: null,
  spreadHome: 3.5,
  total: 42.5,
};

describe('resolvePrior', () => {
  it('ESPN lines come first and de-vig both sides', () => {
    const p = resolvePrior(
      'nfl',
      {
        espnLines: RAMS_LINES,
        entered: [
          {
            market: 'moneyline',
            selectionKind: 'team',
            side: 'away',
            line: null,
            price: -190,
          },
        ],
      },
      PARAMS
    );
    // implied 1/2.54 = 0.393701 and 1/1.540541 = 0.649123; total 1.042824
    expect(p.source).toBe('espn_lines');
    expect(p.homeWin).toBeCloseTo(0.377534, 5);
    expect(p.awayWin).toBeCloseTo(0.622466, 5);
    expect(p.expectedMargin).toBe(-3.5);
    expect(p.expectedTotal).toBe(42.5);
    expect(p.detail).toBe(
      'DraftKings via ESPN: ML +154/-185, home +3.5, o/u 42.5'
    );
  });

  it('the Odds API snapshot is next', () => {
    const p = resolvePrior(
      'nfl',
      { snapshot: { ...RAMS_LINES, spreadHome: null } },
      PARAMS
    );
    expect(p.source).toBe('pregame_snapshot');
    // margin from the moneyline: 13.5 x Phi^-1(0.377534)
    expect(p.expectedMargin).toBeCloseTo(13.5 * normalQuantile(0.377534), 4);
  });

  it('entered odds: one price de-vigged at 4.5% hold, total from another leg', () => {
    // Minnesota (home) ML +184 and Over 41.5 on the same game
    const p = resolvePrior(
      'ncaaf',
      {
        entered: [
          {
            market: 'moneyline',
            selectionKind: 'team',
            side: 'home',
            line: null,
            price: 184,
          },
          {
            market: 'total',
            selectionKind: 'over',
            side: null,
            line: 41.5,
            price: 102,
          },
        ],
      },
      PARAMS
    );
    // (1 / 2.84) / 1.045 = 0.336946
    const pHome = 1 / 2.84 / 1.045;
    expect(p.source).toBe('entered_odds');
    expect(p.homeWin).toBeCloseTo(0.336946, 5);
    expect(p.expectedMargin).toBeCloseTo(15 * normalQuantile(pHome), 8);
    expect(p.expectedTotal).toBe(41.5);
    expect(p.detail).toBe('entered odds: home ML +184, o/u 41.5');
  });

  it('an entered spread sets the margin; win prob follows from it', () => {
    // Mississippi State (home) +5.5 -> home expected margin -5.5
    const p = resolvePrior(
      'ncaaf',
      {
        entered: [
          {
            market: 'spread',
            selectionKind: 'team',
            side: 'home',
            line: 5.5,
            price: -104,
          },
        ],
      },
      PARAMS
    );
    expect(p.expectedMargin).toBe(-5.5);
    expect(p.homeWin).toBeLessThan(0.4);
    expect(p.expectedTotal).toBe(55);
    expect(p.detail).toContain('league-average total 55');
  });

  it('fills a missing total from a later source', () => {
    const p = resolvePrior(
      'nfl',
      {
        espnLines: { ...RAMS_LINES, total: null },
        entered: [
          {
            market: 'total',
            selectionKind: 'over',
            side: null,
            line: 44.5,
            price: -110,
          },
        ],
      },
      PARAMS
    );
    expect(p.source).toBe('espn_lines');
    expect(p.expectedTotal).toBe(44.5);
    expect(p.detail).toContain('entered odds: o/u 44.5');
  });

  it('neutral when nothing prices the game', () => {
    const p = resolvePrior('mlb', {}, PARAMS);
    expect(p).toMatchObject({
      source: 'neutral',
      homeWin: 0.5,
      awayWin: 0.5,
      expectedTotal: 8.8,
      expectedMargin: null,
    });
  });

  it('soccer: an entered draw price fills an even 3-way', () => {
    // (1 / 4.5) / 1.06 = 0.209644
    const p = resolvePrior(
      'soccer',
      {
        entered: [
          {
            market: 'moneyline3way',
            selectionKind: 'draw',
            side: null,
            line: null,
            price: 350,
          },
        ],
      },
      PARAMS
    );
    expect(p.draw).toBeCloseTo(0.209644, 5);
    expect(p.homeWin).toBeCloseTo((1 - 0.209644) / 2, 5);
    expect(p.homeWin + p.draw + p.awayWin).toBeCloseTo(1, 10);
  });

  it('MMA uses the moneyline only', () => {
    const p = resolvePrior(
      'mma',
      {
        entered: [
          {
            market: 'moneyline',
            selectionKind: 'team',
            side: 'away',
            line: null,
            price: 216,
          },
        ],
      },
      PARAMS
    );
    expect(p.awayWin).toBeCloseTo(1 / 3.16 / 1.045, 6);
    expect(p.expectedTotal).toBeNull();
  });
});
