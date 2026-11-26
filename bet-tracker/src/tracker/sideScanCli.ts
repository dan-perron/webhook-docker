import { appConfig } from '../config.js';
import { openDb } from '../db/client.js';
import { scanSides } from './sideScan.js';

// Usage: node built/tracker/sideScanCli.js [--json] [--all]
// Read-only: every matched team leg's stored side vs the side derived from
// ESPN (the latest state's home/away, else the event row; series: the
// series row), with what a settled leg's result would be on the right side.
// --all also lists legs that agree. Changes nothing.
const db = openDb(appConfig.databasePath);
const rows = scanSides(db, { all: process.argv.includes('--all') });
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  for (const r of rows) {
    console.log(
      [
        `bet ${r.betId} leg ${r.legId}`,
        `[${r.betStatus}/${r.legStatus}]`,
        `${r.sport} ${r.market} ${r.selection}`,
        `${r.matchup}`,
        `stored ${r.storedSide ?? '-'} (prices ${r.pricedTeam ?? '-'})`,
        `espn ${r.espnSide ?? '?'}`,
        r.rowSwapped ? 'ROW SWAPPED vs state' : '',
        r.problem,
        r.correctResult ? `correct result: ${r.correctResult}` : '',
      ]
        .filter(Boolean)
        .join(' | ')
    );
  }
  console.log(`${rows.length} leg(s) listed from ${appConfig.databasePath}.`);
}
db.$client.close();
