# OddsPapi fixtures

Trimmed from real api.oddspapi.io v4 responses for Dallas Mavericks v LA
Clippers, 2026-11-22T01:00Z (fixture `id1100013273719724`).

- `nba-2026-11-22-fixtures.json`: `/v4/fixtures?tournamentId=132` for that
  evening, three of the games, fields cut to the ones the client reads.
- `nba-dal-lac-historical.json`: `/v4/historical-odds` for DraftKings,
  FanDuel and Pinnacle. Kept: the full-game moneyline (111), spreads -6.5,
  -5.5 and -4.5, totals 229.5 and 230.5 (Pinnacle: moneyline only); per
  outcome the last two entries before 00:55Z and the first one after.

Hand-built in the documented v4 shapes (no API call was made for them; the
tests never call the real API):

- `nba-dal-lac-odds.json`: `/v4/odds` for the same fixture, as if before
  tip-off. Edits from the documented shape and the recorded history above:
  - DraftKings and FanDuel prices are their recorded 22:36Z history prices;
    `priceAmerican` is what those decimals round to, except Pinnacle's
    moneyline 1.52 sent as `-193` (1.52 rounds to -192) so a test can tell
    the API's American price is used, not recomputed.
  - Pinnacle's spread -4.5 (1.90 / 1.95) and total are made up; its total's
    Over is `active: false` (so the pair is dropped).
  - Caesars (slug `caesars`) and an inactive BetRivers are added; market
    `99999` (not in the catalogue) and a Cooper Flagg points 28.5 prop
    (market `111678`, player key `80021`) are made up.
- `markets-sample.json`: `/v4/markets` entries: the moneyline (111) and the
  spread/total ids above with the recorded table's handicaps, the made-up
  prop market, plus three that must be left out (a 1st-quarter spread, a
  points ladder, a soccer 1X2).
