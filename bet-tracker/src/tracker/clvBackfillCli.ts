import { appConfig } from '../config.js';
import { openDb } from '../db/client.js';
import { createServices } from '../services.js';

// Usage: node built/tracker/clvBackfillCli.js [--dry-run] [--max-cost N]
// Closes for settled legs that have none, from Odds API historical odds
// (Tracker.backfillCloses). Paid plans only: on the free plan the first call
// is refused (no quota spent), nothing is written and the count is reported.
const dryRun = process.argv.includes('--dry-run');
const i = process.argv.indexOf('--max-cost');
const maxCost = i > 0 ? Number(process.argv[i + 1]) : undefined;
const db = openDb(appConfig.databasePath);
const { tracker, odds } = createServices(db);
const r = await tracker.backfillCloses({ dryRun, maxCost });
console.log(
  `${r.missingClose} settled leg(s) without a close; ${r.eligible} priceable in ${r.windows} window(s), ~${r.estimatedCost} request(s) (${odds.quota().remaining ?? '?'} left this month).`
);
for (const [reason, n] of Object.entries(r.skipped))
  console.log(`  not priceable: ${n} ${reason}`);
if (!dryRun) {
  if (r.planAvailable === false)
    console.log(
      `Historical odds are not on this plan: ${r.eligible} leg(s) left null.`
    );
  console.log(
    `Filled ${r.filled}; ${r.eligible - r.filled} still without a close; spent ~${r.spent}.`
  );
}
for (const e of r.errors) console.log(`  ${e}`);
db.$client.close();
