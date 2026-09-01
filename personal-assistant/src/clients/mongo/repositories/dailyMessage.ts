import { database } from '../connection.js';
import type { DailyMessage } from '../../../features/exercises/types.js';

const collection = database.collection<DailyMessage>('dailyMessages');

export async function getDailyMessage(
  userId: string,
  date: string
): Promise<DailyMessage | null> {
  return collection.findOne({ userId, date });
}

export async function saveDailyMessage(
  userId: string,
  date: string,
  channelId: string,
  messageTs: string
): Promise<void> {
  await collection.updateOne(
    { userId, date },
    { $setOnInsert: { userId, date, channelId, messageTs } },
    { upsert: true }
  );
}

export async function getOldDailyMessages(
  userId: string,
  beforeDate: string
): Promise<DailyMessage[]> {
  return collection.find({ userId, date: { $lt: beforeDate } }).toArray();
}

export async function deleteOldDailyMessages(
  userId: string,
  beforeDate: string
): Promise<void> {
  await collection.deleteMany({ userId, date: { $lt: beforeDate } });
}
