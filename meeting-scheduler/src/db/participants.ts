import { ObjectId } from 'mongodb';
import { participantsCollection } from './connection.js';
import { newToken } from '../util/id.js';
import type { Participant, SlotState } from './types.js';

/** Everyone on the event, in join order — this is also the heatmap's roster. */
export function listForEvent(eventId: ObjectId): Promise<Participant[]> {
  return participantsCollection
    .find({ eventId })
    .sort({ createdAt: 1 })
    .toArray();
}

export function getByToken(
  eventId: ObjectId,
  token: string
): Promise<Participant | null> {
  return participantsCollection.findOne({ eventId, token });
}

export function getById(
  eventId: ObjectId,
  id: string
): Promise<Participant | null> {
  if (!ObjectId.isValid(id)) return Promise.resolve(null);
  return participantsCollection.findOne({ eventId, _id: new ObjectId(id) });
}

export function findByName(
  eventId: ObjectId,
  name: string
): Promise<Participant | null> {
  // Exact match after trimming; the collision confirm handles the rest.
  return participantsCollection.findOne({ eventId, name });
}

export async function createParticipant(
  eventId: ObjectId,
  name: string,
  timezone: string | null = null
): Promise<Participant> {
  const now = new Date();
  const doc: Participant = {
    eventId,
    name,
    token: newToken(),
    slots: {},
    timezone,
    respondedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await participantsCollection.insertOne(doc);
  return doc;
}

/** Change the zone this person reads the grid in. Never touches slot keys. */
export async function setTimezone(
  participant: Participant,
  timezone: string | null
): Promise<void> {
  await participantsCollection.updateOne(
    { _id: participant._id },
    { $set: { timezone, updatedAt: new Date() } }
  );
}

/**
 * Give an existing participant a fresh token — used when someone claims a row
 * ("I'm Dan") from a browser that has no cookie for it. Rotating rather than
 * reusing means a stale cookie elsewhere stops working, which is the behaviour
 * you want when a row changes hands.
 */
export async function claimParticipant(
  participant: Participant
): Promise<Participant> {
  const token = newToken();
  await participantsCollection.updateOne(
    { _id: participant._id },
    { $set: { token, updatedAt: new Date() } }
  );
  return { ...participant, token };
}

/** Pick a free name when someone insists they're a *different* Dan. */
export async function uniqueName(
  eventId: ObjectId,
  base: string
): Promise<string> {
  for (let n = 2; n < 100; n++) {
    const candidate = `${base} (${n})`;
    if (!(await findByName(eventId, candidate))) return candidate;
  }
  return `${base} (${Date.now()})`;
}

export interface SlotChange {
  key: string;
  /** 'none' clears the slot. */
  value: SlotState | 'none';
}

/**
 * Apply a batch of painted cells in one atomic update. Uses dotted `$set` /
 * `$unset` paths rather than replacing `slots` wholesale, so a concurrent
 * rename can't be clobbered by a save that started before it.
 */
export async function applyChanges(
  participant: Participant,
  changes: SlotChange[]
): Promise<void> {
  if (!changes.length) return;
  const now = new Date();
  const $set: Record<string, unknown> = { respondedAt: now, updatedAt: now };
  const $unset: Record<string, ''> = {};
  for (const { key, value } of changes) {
    if (value === 'none') $unset[`slots.${key}`] = '';
    else $set[`slots.${key}`] = value;
  }
  await participantsCollection.updateOne(
    { _id: participant._id, eventId: participant.eventId },
    Object.keys($unset).length ? { $set, $unset } : { $set }
  );
}
