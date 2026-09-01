import { eventsCollection } from './connection.js';
import { newSlug, newToken } from '../util/id.js';
import type { EventDoc } from './types.js';

export interface NewEventInput {
  title: string;
  dates: string[];
  startMinute: number;
  endMinute: number;
  slotMinutes: number;
  timezone: string;
}

export async function createEvent(input: NewEventInput): Promise<EventDoc> {
  const doc: EventDoc = {
    ...input,
    dates: [...input.dates].sort(),
    slug: newSlug(),
    adminToken: newToken(),
    createdAt: new Date(),
  };
  await eventsCollection.insertOne(doc);
  return doc;
}

export function getEventBySlug(slug: string): Promise<EventDoc | null> {
  return eventsCollection.findOne({ slug });
}
