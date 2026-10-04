#!/usr/bin/env python3
"""Fit NFL key-number weights for the final-margin model.

Model (same as src/models/football.ts):
    P(margin = m) ∝ φ((m − μ) / σ) · w(|m|),   m integer
    μ = home closing spread (home favored > 0), σ per game chosen so the
    model's P(home win | not a tie) equals the de-vigged closing moneyline.

w(k) is fitted by iterative proportional fitting: w(k) *= observed count of
|margin| = k / expected count, alternating with the per-game σ solve.
k > TAIL shares one weight. Data: nflverse games.csv (closing lines).

Usage: python3 scripts/fit_key_numbers.py games.csv > src/models/data/nfl-key-numbers.json
"""
import csv, json, math, sys
from datetime import date

FIRST_SEASON = 2002      # 32-team era
TAIL = 21                # |m| > TAIL share one weight
M = 70                   # margins evaluated in [-M, M]
SIGMA_DEFAULT, SIGMA_LO, SIGMA_HI = 13.5, 10.0, 16.0
ROUNDS, IPF_ITERS = 4, 60

def dec(a): return 1 + a / 100 if a > 0 else 1 + 100 / -a

def phi(z): return math.exp(-0.5 * z * z)

def pmf(mu, sigma, w):
    ps = [phi((m - mu) / sigma) * w[min(abs(m), TAIL + 1)] for m in range(-M, M + 1)]
    s = sum(ps)
    return [p / s for p in ps]

def home_win(p):
    win = sum(p[M + 1:]); tie = p[M]
    return win / (1 - tie)

def solve_sigma(mu, target, w):
    if mu == 0 or target is None or (mu > 0) != (target > 0.5):
        return SIGMA_DEFAULT
    lo, hi = SIGMA_LO, SIGMA_HI
    f = lambda s: home_win(pmf(mu, s, w)) - target
    # P(home) moves toward 0.5 as sigma grows.
    if mu > 0:
        if f(lo) < 0: return lo
        if f(hi) > 0: return hi
    else:
        if f(lo) > 0: return lo
        if f(hi) < 0: return hi
    for _ in range(40):
        mid = (lo + hi) / 2
        if (f(mid) > 0) == (mu > 0): lo = mid
        else: hi = mid
    return (lo + hi) / 2

def main(path):
    games = []
    for r in csv.DictReader(open(path)):
        if r['result'] in ('', 'NA') or r['spread_line'] in ('', 'NA'): continue
        if int(r['season']) < FIRST_SEASON: continue
        target = None
        if r['home_moneyline'] not in ('', 'NA') and r['away_moneyline'] not in ('', 'NA'):
            ih, ia = 1 / dec(float(r['home_moneyline'])), 1 / dec(float(r['away_moneyline']))
            target = ih / (ih + ia)
        games.append((float(r['spread_line']), target, int(float(r['result']))))
    w = [1.0] * (TAIL + 2)
    observed = [0] * (TAIL + 2)
    for _, _, res in games: observed[min(abs(res), TAIL + 1)] += 1
    sigmas = [SIGMA_DEFAULT] * len(games)
    for rnd in range(ROUNDS):
        sigmas = [solve_sigma(mu, t, w) for mu, t, _ in games]
        for _ in range(IPF_ITERS):
            expected = [0.0] * (TAIL + 2)
            for (mu, _, _), s in zip(games, sigmas):
                for m, p in zip(range(-M, M + 1), pmf(mu, s, w)):
                    expected[min(abs(m), TAIL + 1)] += p
            w = [wk * (o / e if e > 0 else 1) for wk, o, e in zip(w, observed, expected)]
            w = [wk / w[TAIL + 1] for wk in w]  # tail weight = 1
        print(f'round {rnd}: w3={w[3]:.3f} w7={w[7]:.3f} w0={w[0]:.3f}', file=sys.stderr)
    n = len(games)
    out = {
        'description': 'NFL final-margin key-number weights w(|m|); index = |m|, last entry applies to every |m| beyond. See scripts/fit_key_numbers.py.',
        'source': 'nflverse games.csv (closing spread_line, moneylines, final result)',
        'seasons': f'{FIRST_SEASON}-{max(int(r["season"]) for r in csv.DictReader(open(path)) if r["result"] not in ("", "NA"))}',
        'games': n,
        'fittedOn': date.today().isoformat(),
        'weights': [round(x, 4) for x in w],
        'observedShare': [round(o / n, 4) for o in observed],
    }
    json.dump(out, sys.stdout, indent=1)
    print()

if __name__ == '__main__':
    main(sys.argv[1])
