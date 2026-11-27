import { appConfig } from '../config.js';
import { openDb } from '../db/client.js';
import { createServices } from '../services.js';
import type { CloseBackfillSource } from './tracker.js';

// Usage: node built/tracker/clvBackfillCli.js [--dry-run] [--max-cost N]
//          [--source auto|oddsapi|oddspapi] [--legs 322,323]
// Closes for settled legs that have none (Tracker.backfillCloses), from Odds
// API historical odds (paid plans: on the free plan the first call is
// refused, no quota spent) or OddsPapi (free on settled games; 1 request per
// window). auto = Odds API with CLV_HISTORICAL=true, else OddsPapi, falling
// back to OddsPapi if the Odds API refuses. --legs re-closes those settled
// legs, replacing whatever close they have.
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const dryRun = process.argv.includes('--dry-run');
const maxCost =
  arg('--max-cost') != null ? Number(arg('--max-cost')) : undefined;
const source = (arg('--source') ?? 'auto') as CloseBackfillSource;
if (!['auto', 'oddsapi', 'oddspapi'].includes(source))
  throw new Error(`--source must be auto, oddsapi or oddspapi`);
const legIds = arg('--legs')?.split(',').map(Number);
if (legIds?.some((n) => !Number.isInteger(n)))
  throw new Error('--legs takes leg ids: --legs 322,323');
const db = openDb(appConfig.databasePath);
const { tracker, odds } = createServices(db);
const r = await tracker.backfillCloses({ dryRun, maxCost, source, legIds });
const left =
  r.source === 'oddspapi'
    ? 'OddsPapi'
    : `${odds.quota().remaining ?? '?'} Odds API requests left this month`;
console.log(
  `${r.missingClose} settled leg(s) ${legIds ? 'named' : 'without a close'}; ${r.eligible} priceable in ${r.windows} window(s), ~${r.estimatedCost} request(s) via ${left}.`
);
for (const [reason, n] of Object.entries(r.skipped))
  console.log(`  not priceable: ${n} ${reason}`);
if (!dryRun) {
  if (r.planAvailable === false && r.source === 'oddsapi')
    console.log(
      `Historical odds are not on this plan: ${r.eligible} leg(s) left null.`
    );
  console.log(
    `Filled ${r.filled}; ${r.eligible - r.filled} still without a close; spent ~${r.spent} (${r.source}).`
  );
}
for (const e of r.errors) console.log(`  ${e}`);
db.$client.close();
