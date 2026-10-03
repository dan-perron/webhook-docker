import { describe, expect, it } from 'vitest';
import {
  americanToDecimal,
  boostDecimal,
  decimalToAmerican,
  devig,
  devigSingle,
  impliedProbability,
  parlayDecimal,
  payoutCents,
} from '../src/odds/math.js';

describe('americanToDecimal / decimalToAmerican', () => {
  it.each([
    [150, 2.5],
    [-200, 1.5],
    [100, 2],
    [-100, 2],
    [-110, 1 + 100 / 110],
  ])('%i -> %f', (american, decimal) => {
    expect(americanToDecimal(american)).toBeCloseTo(decimal, 10);
  });

  it.each([
    [2.5, 150],
    [1.5, -200],
    [2, 100],
    [26 / 10, 160],
  ])('%f -> %i', (decimal, american) => {
    expect(decimalToAmerican(decimal)).toBe(american);
  });

  it('rejects prices between -100 and +100', () => {
    expect(() => americanToDecimal(50)).toThrow(RangeError);
    expect(() => americanToDecimal(-99)).toThrow(RangeError);
  });
});

describe('impliedProbability / devig', () => {
  it('-110 implies 52.38%', () => {
    expect(impliedProbability(-110)).toBeCloseTo(0.5238095, 6);
  });

  it('-110/-110 is 50/50 with 4.76% hold', () => {
    const { fair, hold } = devig([-110, -110]);
    expect(fair[0]).toBeCloseTo(0.5, 10);
    expect(fair[1]).toBeCloseTo(0.5, 10);
    expect(hold).toBeCloseTo(0.047619, 5);
  });

  it('-150/+130: 0.6 and 0.434783 implied, normalized by 1.034783', () => {
    const { fair, hold } = devig([-150, 130]);
    expect(fair[0]).toBeCloseTo(0.579832, 5);
    expect(fair[1]).toBeCloseTo(0.420168, 5);
    expect(hold).toBeCloseTo(0.034783, 5);
  });

  it('3-way +150/+240/+190 sums to 1', () => {
    // implied 0.4, 0.294118, 0.344828; total 1.038945
    const { fair, hold } = devig([150, 240, 190]);
    expect(fair[0]).toBeCloseTo(0.385006, 5);
    expect(fair[1]).toBeCloseTo(0.283096, 5);
    expect(fair[2]).toBeCloseTo(0.331898, 5);
    expect(hold).toBeCloseTo(0.038945, 5);
  });

  it('single-sided devig assumes the default 4.5% hold', () => {
    // 0.5238095 / 1.045
    expect(devigSingle(-110)).toBeCloseTo(0.501253, 5);
  });
});

describe('parlay and boost math', () => {
  it('Braves +180 / Yankees +114 / Brewers -210 is +785', () => {
    // 2.8 x 2.14 x 1.476190 = 8.845333
    const d = parlayDecimal([180, 114, -210]);
    expect(d).toBeCloseTo(8.845333, 5);
    expect(decimalToAmerican(d)).toBe(785);
  });

  it('25% profit boost on +128 is +160', () => {
    // 1 + 1.28 x 1.25 = 2.6
    expect(boostDecimal(2.28, 25)).toBeCloseTo(2.6, 10);
  });

  it('payout rounds to the cent', () => {
    expect(payoutCents(1000, 2.6)).toBe(2600);
    expect(payoutCents(500, americanToDecimal(-190))).toBe(763);
  });
});
