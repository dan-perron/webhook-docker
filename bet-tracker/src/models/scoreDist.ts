import type { JointOutcome } from '../domain/value.js';
import { legResult, type ModelSelection, type Outcome } from './types.js';

// Joint distribution of final (home, away) scores. MLB, NHL and soccer
// models produce one; every market and same-game combination is read off it
// exactly.

export class ScoreDist {
  readonly p: Float64Array;

  constructor(readonly cap: number) {
    this.p = new Float64Array((cap + 1) * (cap + 1));
  }

  add(home: number, away: number, p: number) {
    const h = Math.min(home, this.cap);
    const a = Math.min(away, this.cap);
    this.p[h * (this.cap + 1) + a]! += p;
  }

  get(home: number, away: number): number {
    if (home > this.cap || away > this.cap) return 0;
    return this.p[home * (this.cap + 1) + away]!;
  }

  *cells(): Generator<[number, number, number]> {
    for (let h = 0; h <= this.cap; h++) {
      for (let a = 0; a <= this.cap; a++) {
        const p = this.p[h * (this.cap + 1) + a]!;
        if (p > 0) yield [h, a, p];
      }
    }
  }

  total(): number {
    return this.p.reduce((a, b) => a + b, 0);
  }
}

/**
 * Every non-losing outcome of `sels` together, with the legs (indices) that
 * push in it. One selection gives its win/push split.
 */
export function jointFromScores(
  dist: ScoreDist,
  sels: ModelSelection[]
): JointOutcome[] {
  const acc = new Map<string, JointOutcome>();
  for (const [h, a, p] of dist.cells()) {
    const pushed: number[] = [];
    let lost = false;
    for (let j = 0; j < sels.length && !lost; j++) {
      const r = legResult(sels[j]!, h - a, h + a);
      if (r === 'lost') lost = true;
      else if (r === 'push') pushed.push(j);
    }
    if (lost) continue;
    const key = pushed.join(',');
    const o = acc.get(key);
    if (o) o.p += p;
    else acc.set(key, { p, pushed });
  }
  return [...acc.values()];
}

export function outcomeFromScores(
  dist: ScoreDist,
  sel: ModelSelection
): Outcome {
  let win = 0;
  let push = 0;
  for (const o of jointFromScores(dist, [sel])) {
    if (o.pushed.length) push += o.p;
    else win += o.p;
  }
  return { win, push };
}
