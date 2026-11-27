# OddsPapi fixtures

Trimmed from real api.oddspapi.io v4 responses for Dallas Mavericks v LA
Clippers, 2026-11-22T01:00Z (fixture `id1100013273719724`).

- `nba-2026-11-22-fixtures.json`: `/v4/fixtures?tournamentId=132` for that
  evening, three of the games, fields cut to the ones the client reads.
- `nba-dal-lac-historical.json`: `/v4/historical-odds` for DraftKings,
  FanDuel and Pinnacle. Kept: the full-game moneyline (111), spreads -6.5,
  -5.5 and -4.5, totals 229.5 and 230.5 (Pinnacle: moneyline only); per
  outcome the last two entries before 00:55Z and the first one after.
