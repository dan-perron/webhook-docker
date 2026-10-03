import { createBet, countBets, type BetWithLegs } from '../db/bets.js';
import type { Db } from '../db/client.js';
import { bets } from '../db/schema.js';
import { seedBets } from './seedData.js';

export interface SeedResult {
  inserted: BetWithLegs[];
  skipped: boolean;
}

/**
 * Insert the seed bets. Idempotent by default: does nothing if any bet
 * exists. `force` deletes all bets (legs/snapshots cascade) first.
 */
export function loadSeed(db: Db, { force = false } = {}): SeedResult {
  return db.transaction((tx) => {
    if (force) tx.delete(bets).run();
    else if (countBets(tx) > 0) {
      return { inserted: [], skipped: true };
    }
    const inserted = seedBets.map((input) => createBet(tx, input));
    return { inserted, skipped: false };
  });
}
