import { appConfig } from '../config.js';
import { openDb } from '../db/client.js';
import { loadSeed } from './load.js';

// Usage: node built/seed/cli.js [--force]
const force = process.argv.includes('--force');
const db = openDb(appConfig.databasePath);
const result = loadSeed(db, { force });
if (result.skipped) {
  console.log('Bets already exist; nothing seeded (use --force to replace).');
} else {
  console.log(
    `Seeded ${result.inserted.length} bets into ${appConfig.databasePath}.`
  );
}
db.$client.close();
