import Database from 'better-sqlite3';
import { appConfig } from './config.js';

// Online backup of the live database (safe while the server writes), then an
// integrity check of the copy. Usage: node built/backup.js <dest.sqlite>
// Run inside the container by bin/backup, which moves the file to the NAS.

const dest = process.argv[2];
if (!dest) {
  console.error('usage: node built/backup.js <dest.sqlite>');
  process.exit(2);
}
const src = new Database(appConfig.databasePath, { fileMustExist: true });
await src.backup(dest);
src.close();
const copy = new Database(dest, { readonly: true });
const check = copy.pragma('integrity_check', { simple: true });
const bets = (
  copy.prepare('select count(*) as n from bets').get() as { n: number }
).n;
copy.close();
if (check !== 'ok') {
  console.error(`backup integrity check failed: ${String(check)}`);
  process.exit(1);
}
console.log(`backup ok: ${dest} (${bets} bets)`);
