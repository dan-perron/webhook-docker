import { appConfig } from '../config.js';
import { openDb } from '../db/client.js';
import { createServices } from '../services.js';

// Usage: node built/tracker/backfillCli.js [--dry-run]
// Re-derive settledAt for bets settled from final scores (Tracker.backfillSettledAt).
const dryRun = process.argv.includes('--dry-run');
const db = openDb(appConfig.databasePath);
const { tracker } = createServices(db);
const changes = await tracker.backfillSettledAt({ dryRun });
for (const c of changes) console.log(`#${c.id}: ${c.from} -> ${c.to}`);
console.log(
  `${changes.length} bet(s) ${dryRun ? 'would change' : 'updated'} in ${appConfig.databasePath}.`
);
db.$client.close();
