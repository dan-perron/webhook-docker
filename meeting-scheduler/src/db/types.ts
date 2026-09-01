import type { ObjectId } from 'mongodb';

/**
 * One scheduling poll. The grid is `dates` across and
 * `startMinute..endMinute` (stepped by `slotMinutes`) down, all wall-clock in
 * `timezone`.
 */
export interface EventDoc {
  _id?: ObjectId;
  /** Random, unguessable. The URL is the only access control this app has. */
  slug: string;
  title: string;
  /** "YYYY-MM-DD", sorted ascending. */
  dates: string[];
  /** Minutes from local midnight, e.g. 540 = 9:00am. */
  startMinute: number;
  /** Exclusive, e.g. 1080 = 6:00pm — the last slot starts before this. */
  endMinute: number;
  slotMinutes: number;
  /** IANA name. Every displayed time is wall-clock in this zone. */
  timezone: string;
  /** The creator's cookie value. Unused today; gates a future edit route. */
  adminToken: string;
  createdAt: Date;
}

/** What someone can say about a slot. Absence of a key means "not available". */
export type SlotState = 'yes' | 'ifNeeded';

export interface Participant {
  _id?: ObjectId;
  eventId: ObjectId;
  name: string;
  /** 32 hex chars; stored in a path-scoped cookie and looked up server-side. */
  token: string;
  /** Sparse: keyed by `YYYY-MM-DD_HHMM`, missing key = not available. */
  slots: Record<string, SlotState>;
  /**
   * The zone THIS person sees times in — detected from their browser on join,
   * changeable on the event page. Null means "use the event's zone".
   *
   * Slot keys stay anchored to the event's timezone no matter what this says,
   * so two people in different zones painting "the same square" always mean the
   * same instant. This only affects labels.
   */
  timezone: string | null;
  /**
   * Set on the first save. Distinguishes "answered, and is busy the whole time"
   * from "never opened the link" — without it the can't-make-it list, which is
   * the whole point of the app, would be a lie.
   */
  respondedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
