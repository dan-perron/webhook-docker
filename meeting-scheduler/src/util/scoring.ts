import type { EventDoc, Participant } from '../db/types.js';
import { contiguousRuns, slotKey } from './slots.js';

/** How a person fares across a whole candidate window. */
export type Availability = 'yes' | 'ifNeeded' | 'no';

export interface Proposal {
  date: string;
  /** Earliest workable start for this (merged) row. */
  startMinute: number;
  /** Latest workable start. Equal to `startMinute` unless rows were merged. */
  lastStartMinute: number;
  /** End of the meeting if you start at `lastStartMinute`. */
  endMinute: number;
  yes: Participant[];
  ifNeeded: Participant[];
  no: Participant[];
}

/**
 * A person counts for a window only if they hold up across EVERY slot in it.
 * Absence of a slot key means not available, so one gap disqualifies the whole
 * window. Note this can only degrade as the duration grows, which is what makes
 * flipping 1 -> 2 -> 3 hours feel coherent.
 */
export function classify(p: Participant, keys: string[]): Availability {
  let soft = false;
  for (const key of keys) {
    const state = p.slots?.[key];
    if (state === undefined) return 'no';
    if (state === 'ifNeeded') soft = true;
  }
  return soft ? 'ifNeeded' : 'yes';
}

/**
 * The window where the most people can actually be there; among those, the one
 * that inconveniences the fewest; then the earliest.
 *
 * Deliberately NOT lexicographic on (yes, ifNeeded): that ranks 10-free/0-maybe
 * above 9-free/5-maybe, but 14 people in the room beats 10, and if-needed
 * people do come — they'd just rather not. Ranking enthusiasm over attendance
 * is the wrong objective for a meeting.
 */
export function compare(a: Proposal, b: Proposal): number {
  const canA = a.yes.length + a.ifNeeded.length;
  const canB = b.yes.length + b.ifNeeded.length;
  if (canA !== canB) return canB - canA;
  if (a.yes.length !== b.yes.length) return b.yes.length - a.yes.length;
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return a.startMinute - b.startMinute;
}

const ids = (ps: Participant[]) =>
  ps
    .map((p) => String(p._id))
    .sort()
    .join(',');

const roster = (p: Proposal) => `${ids(p.yes)}|${ids(p.ifNeeded)}`;

/**
 * Fold chronologically adjacent same-date windows that have an identical roster
 * into one row with a start range. For a 2-hour meeting, starts at 9:00,
 * 10:00 and 11:00 usually have exactly the same people; unmerged you get a wall
 * of near-duplicates instead of a proposal.
 *
 * Requires chronological input — merge before sorting by score, never after.
 */
export function merge(windows: Proposal[], slotMinutes: number): Proposal[] {
  const out: Proposal[] = [];
  for (const w of windows) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.date === w.date &&
      w.startMinute === prev.lastStartMinute + slotMinutes &&
      roster(prev) === roster(w)
    ) {
      prev.lastStartMinute = w.startMinute;
      prev.endMinute = w.endMinute;
    } else {
      out.push({ ...w });
    }
  }
  return out;
}

/**
 * Rank every contiguous `durationMinutes` window in the event.
 *
 * `responders` must exclude anyone who has never saved — they are reported
 * separately. Folding them into "can't make it" makes every window look worse
 * than it is and hides the difference between "Amy is busy" and "Amy never
 * opened the link".
 */
export function rankProposals(
  ev: EventDoc,
  responders: Participant[],
  durationMinutes: number
): Proposal[] {
  const perWindow = Math.max(1, Math.round(durationMinutes / ev.slotMinutes));
  const windows: Proposal[] = [];

  for (const date of ev.dates) {
    for (const run of contiguousRuns(ev, date)) {
      for (let i = 0; i + perWindow <= run.length; i++) {
        const minutes = run.slice(i, i + perWindow);
        const keys = minutes.map((m) => slotKey(date, m));
        const proposal: Proposal = {
          date,
          startMinute: minutes[0],
          lastStartMinute: minutes[0],
          endMinute: minutes[0] + durationMinutes,
          yes: [],
          ifNeeded: [],
          no: [],
        };
        for (const p of responders) proposal[classify(p, keys)].push(p);
        windows.push(proposal);
      }
    }
  }

  // Chronological -> merge -> rank. The order matters: merge() walks neighbours.
  return merge(windows, ev.slotMinutes).sort(compare);
}
