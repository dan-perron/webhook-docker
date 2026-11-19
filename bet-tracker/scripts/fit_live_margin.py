#!/usr/bin/env python3
"""Fit the live basketball margin shape (models/prior.ts LiveMarginShape).

Model, with f = share of regulation left, L = home lead, mu = -closing spread:
    remaining margin R ~ Normal(mu f - a f^b c tanh(L / c), (sigma f^k)^2)
    P(home) = P(L + R >= 1) + P(L + R = 0) x (0.5 + (p_pre - 0.5) / 2)
a, b, c, k are fitted by maximum likelihood on the remaining regulation margin
at every 24 s of game clock; sigma = sd(final regulation margin - mu).
A per-game sigma implied by the moneyline is not used: near pick-em it is
unidentified (mu / Phi^-1(p) with p ~ 0.5) and carries no live information.

Data: ESPN game summaries (play-by-play) + core API odds (closing spread and
moneylines), one compact JSON line per game.

  python3 scripts/fit_live_margin.py fetch nba 20221018 20230615 nba22.jsonl
  python3 scripts/fit_live_margin.py fit nba nba25.jsonl nba22.jsonl nba23.jsonl ...
      (first file = held-out season; fit needs numpy + scipy, e.g. in
       python:3.12-slim with `pip install numpy scipy`)
"""
import json
import math
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

LEAGUE = {"nba": "nba", "ncaab": "mens-college-basketball"}
PERIODS = {"nba": (4, 720), "ncaab": (2, 1200)}  # count, seconds
GRID = 12  # seconds between stored margins


# --- fetch ------------------------------------------------------------------


def get(url, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                print("FAIL", url, e, file=sys.stderr)
                return None
            time.sleep(2 * (i + 1))


def clock_seconds(s):
    if ":" in s:
        m, sec = s.split(":")
        return int(m) * 60 + float(sec)
    return float(s)


def game(sport, eid):
    lg = LEAGUE[sport]
    s = get(f"https://site.api.espn.com/apis/site/v2/sports/basketball/{lg}/summary?event={eid}")
    if not s or not s.get("plays"):
        return None
    comp = s["header"]["competitions"][0]
    if not comp["status"]["type"].get("completed"):
        return None
    teams = {c["homeAway"]: c for c in comp["competitors"]}
    hs, aws = int(teams["home"]["score"]), int(teams["away"]["score"])
    if hs == aws:
        return None
    o = get(
        f"https://sports.core.api.espn.com/v2/sports/basketball/leagues/{lg}"
        f"/events/{eid}/competitions/{eid}/odds"
    )
    spread = hml = aml = total = None
    for it in (o or {}).get("items", []):
        if it.get("spread") is None:
            continue
        spread = float(it["spread"])  # home line, negative = home favored
        total = it.get("overUnder")
        hml = (it.get("homeTeamOdds") or {}).get("moneyLine")
        aml = (it.get("awayTeamOdds") or {}).get("moneyLine")
        break
    n, plen = PERIODS[sport]
    reg = n * plen
    pts, ot = [], False
    for p in s["plays"]:
        per = p["period"]["number"]
        if per > n:
            ot = True
            continue
        try:
            c = clock_seconds(p["clock"]["displayValue"])
        except Exception:  # noqa: BLE001
            continue
        pts.append(((per - 1) * plen + (plen - c), p["homeScore"] - p["awayScore"]))
    pts.sort(key=lambda x: x[0])
    grid, j, m = [], 0, 0
    for t in range(0, reg + 1, GRID):
        while j < len(pts) and pts[j][0] <= t:
            m = pts[j][1]
            j += 1
        grid.append(m)
    return {
        "id": eid,
        "season_type": s["header"].get("season", {}).get("type"),
        "spread": spread,
        "total": total,
        "hml": hml,
        "aml": aml,
        "final": hs - aws,
        "reg_margin": pts[-1][1] if pts else 0,
        "ot": ot,
        "grid": grid,
    }


def fetch(sport, a, b, out):
    lg = LEAGUE[sport]
    d = date(int(a[:4]), int(a[4:6]), int(a[6:]))
    end = date(int(b[:4]), int(b[4:6]), int(b[6:]))
    ids = set()
    while d <= end:
        extra = "&groups=50&limit=500" if sport == "ncaab" else ""
        sb = get(f"https://site.api.espn.com/apis/site/v2/sports/basketball/{lg}/scoreboard?dates={d:%Y%m%d}{extra}")
        for e in (sb or {}).get("events", []):
            if e.get("season", {}).get("type") in (2, 3):  # regular + post
                ids.add(e["id"])
        d += timedelta(days=1)
    with open(out, "w") as f, ThreadPoolExecutor(8) as ex:
        for r in ex.map(lambda i: game(sport, i), sorted(ids)):
            if r:
                f.write(json.dumps(r) + "\n")


# --- fit --------------------------------------------------------------------


def fit(sport, test_file, train_files):
    import numpy as np
    from scipy.optimize import minimize
    from scipy.stats import norm

    n, plen = PERIODS[sport]
    reg = n * plen

    def load(files):
        gs = [json.loads(line) for f in files for line in open(f)]
        return [g for g in gs if g["spread"] is not None]

    def samples(games, sigma):
        rows = []
        for g in games:
            for t in range(24, reg, 24):
                lead = g["grid"][t // GRID]
                rows.append((-g["spread"], sigma, (reg - t) / reg, lead,
                             g["reg_margin"] - lead, 1.0 if g["final"] > 0 else 0.0))
        return np.array(rows)

    train, test = load(train_files), load([test_file])
    sigma = float(np.std([g["reg_margin"] + g["spread"] for g in train]))
    S, T = samples(train, sigma), samples(test, sigma)

    def mean_sd(th, X):
        mu, sg, f, lead = X[:, 0], X[:, 1], X[:, 2], X[:, 3]
        a, b, k, c = th
        return mu * f - a * f**b * c * np.tanh(lead / c), sg * f**k

    def nll(th, X):
        m, sd = mean_sd(th, X)
        return np.mean(0.5 * ((X[:, 4] - m) / sd) ** 2 + np.log(sd))

    def p_win(th, X):
        m, sd = mean_sd(th, X)
        fin = X[:, 3] + m
        lo, hi = norm.cdf((-0.5 - fin) / sd), norm.cdf((0.5 - fin) / sd)
        ot = 0.5 + (norm.cdf(X[:, 0] / X[:, 1]) - 0.5) * 0.5
        return 1 - hi + (hi - lo) * ot

    def logloss(p, y):
        p = np.clip(p, 1e-6, 1 - 1e-6)
        return -np.mean(y * np.log(p) + (1 - y) * np.log(1 - p))

    walk = np.array([0.0, 1.0, 0.5, 1.0])  # a = 0: the old random walk
    r = minimize(lambda v: nll(v, S), [0.3, 0.6, 0.45, 15.0],
                 bounds=[(0, 1.5), (0, 3), (0.2, 0.8), (2, 80)], method="L-BFGS-B")
    th = r.x
    print(json.dumps({"sigma": round(sigma, 2), "reversion": round(th[0], 3),
                      "reversionPower": round(th[1], 3), "sdPower": round(th[2], 3),
                      "reversionCap": round(th[3], 1)}))
    y = T[:, 5]
    for name, t in (("random walk", walk), ("fitted", th)):
        p = p_win(t, T)
        print(f"held-out {name:12s} logloss {logloss(p, y):.4f}  brier {np.mean((p - y) ** 2):.4f}")
    print("\nheld-out calibration: bucket  n  predicted  actual (random walk | fitted)")
    edges = [0, .02, .05, .1, .2, .3, .4, .5, .6, .7, .8, .9, .95, .98, 1.0001]
    pw, pf = p_win(walk, T), p_win(th, T)
    for lo, hi in zip(edges, edges[1:]):
        cells = []
        for p in (pw, pf):
            m = (p >= lo) & (p < hi)
            cells.append(f"{m.sum():7d} {p[m].mean():.3f} {y[m].mean():.3f}" if m.any() else "-")
        print(f"{lo:.2f}-{min(hi, 1):.2f}  " + "  |  ".join(cells))


if __name__ == "__main__":
    cmd, sport, *rest = sys.argv[1:]
    if cmd == "fetch":
        fetch(sport, *rest)
    else:
        fit(sport, rest[0], rest[1:])
