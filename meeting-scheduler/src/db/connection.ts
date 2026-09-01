import { MongoClient } from 'mongodb';
import { appConfig } from '../config.js';
import type { EventDoc, Participant } from './types.js';

const client = new MongoClient(appConfig.mongo.connectionString);
const database = client.db(appConfig.mongo.database);

export const eventsCollection = database.collection<EventDoc>('events');
export const participantsCollection =
  database.collection<Participant>('participants');

/**
 * Called once at startup. The unique index on `slug` is a correctness
 * guarantee, not a perf tweak — slug is resolved on every single request.
 */
export async function ensureIndexes(): Promise<void> {
  await eventsCollection.createIndex({ slug: 1 }, { unique: true });
  await participantsCollection.createIndex({ token: 1 }, { unique: true });
  await participantsCollection.createIndex({ eventId: 1 });
}

export { client, database };
