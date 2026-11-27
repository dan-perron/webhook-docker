#!/usr/bin/env python3
"""Trim the OddsPapi market catalogue to the full-game markets closes use.

Usage:
  curl -s "https://api.oddspapi.io/v4/markets?language=en&apiKey=$ODDSPAPI_KEY" > markets.json
  python3 scripts/oddspapi_markets.py markets.json > src/odds/data/oddspapi-markets.json

Keeps, per sport (11 basketball, 13 baseball, 14 American football, 15 ice
hockey), the period "result" (incl. overtime / extra innings / shootout)
moneyline, spreads and totals: marketId -> [type, handicap, first, second],
where first is outcome "1" (participant1; spreads: its handicap) or "Over".
"""
import json
import sys

SPORTS = {11, 13, 14, 15}
TYPES = {'moneyline': 'h2h', 'spreads': 'spreads', 'totals': 'totals'}
FIRST = {'1', 'Over'}

out = {}
for m in json.load(open(sys.argv[1])):
    if m['sportId'] not in SPORTS or m['playerProp'] or m['period'] != 'result':
        continue
    t = TYPES.get(m['marketType'])
    if not t or len(m['outcomes']) != 2:
        continue
    a, b = m['outcomes']
    if a['outcomeName'] not in FIRST:
        a, b = b, a
    if a['outcomeName'] not in FIRST:
        continue
    out.setdefault(str(m['sportId']), {})[str(m['marketId'])] = [
        t, m['handicap'], a['outcomeId'], b['outcomeId']]
json.dump(out, sys.stdout, separators=(',', ':'), sort_keys=True)
sys.stdout.write('\n')
