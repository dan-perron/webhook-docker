// Numeric building blocks for the models: normal CDF/quantile, Poisson pmf,
// and a seedable RNG with Poisson/gamma samplers.

/** Complementary error function (Numerical Recipes erfcc, |rel err| < 1.2e-7). */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t *
                                  (1.48851587 +
                                    t * (-0.82215223 + t * 0.17087277))))))))
    );
  return x >= 0 ? r : 2 - r;
}

/** Standard normal CDF. */
export function normalCdf(x: number): number {
  return 0.5 * erfc(-x / Math.SQRT2);
}

/** Standard normal quantile (Acklam, |rel err| < 1.2e-9). */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError(`p must be in (0,1): ${p}`);
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269,
    -30.66479806614716, 2.506628277459239,
  ];
  const b = [
    -54.47609879822406, 161.5858368580409, -155.6989798598866,
    66.80131188771972, -13.28068155288572,
  ];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    0.007784695709041462, 0.3224671290700398, 2.445134137142996,
    3.754408661907416,
  ];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q +
        c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }
  if (p > 1 - lo) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r +
      a[5]!) *
      q) /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  );
}

/** Poisson pmf for k = 0..max (the tail beyond max is negligible for our rates). */
export function poissonPmf(lambda: number, max: number): number[] {
  const out: number[] = [];
  let p = Math.exp(-lambda);
  for (let k = 0; k <= max; k++) {
    out.push(p);
    p = (p * lambda) / (k + 1);
  }
  return out;
}

export type Rng = () => number;

/** mulberry32: small, fast, seedable uniform [0,1) generator. */
export function seededRng(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Poisson sample by inversion (fine for the small means used here). */
export function samplePoisson(lambda: number, rng: Rng): number {
  if (lambda <= 0) return 0;
  let k = 0;
  let p = Math.exp(-lambda);
  let cum = p;
  const u = rng();
  while (u > cum && k < 100) {
    k++;
    p = (p * lambda) / k;
    cum += p;
  }
  return k;
}

export const logit = (p: number) => {
  const q = Math.min(1 - 1e-9, Math.max(1e-9, p));
  return Math.log(q / (1 - q));
};
export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** A parameter's bounds; the solver works on an unbounded transform. */
export interface Bound {
  lo: number;
  hi: number;
}

const toInner = (x: number, b: Bound) => logit((x - b.lo) / (b.hi - b.lo));
const toOuter = (u: number, b: Bound) => b.lo + (b.hi - b.lo) * sigmoid(u);

/**
 * Bounded least squares (Levenberg–Marquardt, finite-difference Jacobian):
 * minimize sum(residuals(x)^2) with each x[i] inside bounds[i]. Small and
 * dependable for the 1–3 parameter fits the priors need.
 */
export function leastSquares(
  residuals: (x: number[]) => number[],
  x0: number[],
  bounds: Bound[],
  opts: { maxIter?: number; tol?: number } = {}
): { x: number[]; cost: number } {
  const maxIter = opts.maxIter ?? 40;
  const tol = opts.tol ?? 1e-10;
  const clampStart = (x: number, b: Bound) =>
    Math.min(
      b.hi - (b.hi - b.lo) * 1e-6,
      Math.max(b.lo + (b.hi - b.lo) * 1e-6, x)
    );
  let u = x0.map((x, i) => toInner(clampStart(x, bounds[i]!), bounds[i]!));
  const outer = (v: number[]) => v.map((x, i) => toOuter(x, bounds[i]!));
  const cost = (r: number[]) => r.reduce((a, b) => a + b * b, 0);
  let r = residuals(outer(u));
  let c = cost(r);
  let lambda = 1e-2;
  const n = u.length;
  for (let iter = 0; iter < maxIter && c > tol; iter++) {
    // Jacobian by forward differences in the inner coordinates.
    const J: number[][] = r.map(() => new Array(n).fill(0));
    for (let j = 0; j < n; j++) {
      const h = 1e-5 * Math.max(1, Math.abs(u[j]!));
      const up = [...u];
      up[j]! += h;
      const rj = residuals(outer(up));
      for (let i = 0; i < r.length; i++) J[i]![j] = (rj[i]! - r[i]!) / h;
    }
    // Normal equations (J^T J + lambda diag) dx = -J^T r.
    const A: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    const g = new Array(n).fill(0);
    for (let i = 0; i < r.length; i++) {
      for (let a = 0; a < n; a++) {
        g[a] += J[i]![a]! * r[i]!;
        const row = A[a]!;
        for (let b = 0; b < n; b++) row[b] = row[b]! + J[i]![a]! * J[i]![b]!;
      }
    }
    let improved = false;
    for (let attempt = 0; attempt < 8 && !improved; attempt++) {
      const M = A.map((row, a) =>
        row.map((v, b) => v + (a === b ? lambda * (1 + v) : 0))
      );
      const dx = solveLinear(
        M,
        g.map((v) => -v)
      );
      if (!dx) {
        lambda *= 10;
        continue;
      }
      const un = u.map((v, i) => v + dx[i]!);
      const rn = residuals(outer(un));
      const cn = cost(rn);
      if (cn < c) {
        u = un;
        r = rn;
        const gain = c - cn;
        c = cn;
        lambda = Math.max(1e-7, lambda / 3);
        improved = true;
        if (gain < tol) iter = maxIter;
      } else {
        lambda *= 4;
      }
    }
    if (!improved) break;
  }
  return { x: outer(u), cost: c };
}

/** Gaussian elimination with partial pivoting; null if singular. */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++)
      if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    if (Math.abs(M[piv]![col]!) < 1e-14) return null;
    [M[col], M[piv]] = [M[piv]!, M[col]!];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r]![col]! / M[col]![col]!;
      for (let k = col; k <= n; k++) M[r]![k]! -= f * M[col]![k]!;
    }
  }
  return M.map((row, i) => row[n]! / row[i]!);
}
