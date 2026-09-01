import dayjs from 'dayjs';
import {
  client,
  ensureIndexes,
  participantsCollection,
} from './db/connection.js';
import { createEvent } from './db/events.js';
import { createParticipant } from './db/participants.js';
import { allMinutes, slotKey } from './util/slots.js';
import { appConfig } from './config.js';
import type { SlotState } from './db/types.js';

/**
 * Seeds a demo poll with a realistic spread of answers.
 *
 * This exists because none of the interesting decisions in this app — the
 * heatmap ramp, how many proposals to show, whether the can't-make-it list is
 * readable — can be evaluated with one participant, and you are not going to
 * recruit fourteen humans to test with.
 */

const NAMES = [
  'Dan',
  'Maya',
  'Priya',
  'Tom',
  'Alex',
  'Sofia',
  'Ben',
  'Nina',
  'Omar',
  'Grace',
  'Leo',
  'Ruth',
  'Kofi',
  'Ines',
];

const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];

async function main() {
  await ensureIndexes();

  const dates: string[] = [];
  for (let d = dayjs().add(1, 'day'); dates.length < 5; d = d.add(1, 'day')) {
    if (d.day() !== 0 && d.day() !== 6) dates.push(d.format('YYYY-MM-DD'));
  }

  const ev = await createEvent({
    title: 'Demo — pick a time',
    dates,
    startMinute: 9 * 60,
    endMinute: 18 * 60,
    slotMinutes: 60,
    timezone: appConfig.defaultTimezone,
  });

  const minutes = allMinutes(ev);

  for (const [i, name] of NAMES.entries()) {
    // Scatter a few people across other zones so the per-viewer rendering is
    // actually exercised by the demo data.
    const zones = [
      null,
      null,
      null,
      'Europe/London',
      'Asia/Tokyo',
      'America/Los_Angeles',
    ];
    const p = await createParticipant(ev._id!, name, zones[i % zones.length]);

    // Two people never answer, so the waiting list and the "not counted above"
    // caveat are both exercised.
    if (i >= NAMES.length - 2) continue;

    const slots: Record<string, SlotState> = {};
    for (const date of dates) {
      if (Math.random() < 0.15) continue; // fully booked that day
      const blocks = 1 + Math.floor(Math.random() * 2);
      for (let b = 0; b < blocks; b++) {
        const start = Math.floor(Math.random() * (minutes.length - 3));
        const len = 2 + Math.floor(Math.random() * 6);
        const state: SlotState = Math.random() < 0.25 ? 'ifNeeded' : 'yes';
        for (let k = start; k < Math.min(start + len, minutes.length); k++) {
          slots[slotKey(date, minutes[k])] = state;
        }
      }
    }

    // Give everyone a shared mid-morning window so there is a clear winner.
    if (Math.random() < 0.85) {
      const date = pick(dates);
      for (const m of [10 * 60, 11 * 60, 12 * 60]) {
        slots[slotKey(date, m)] = 'yes';
      }
    }

    await participantsCollection.updateOne(
      { _id: p._id },
      { $set: { slots, respondedAt: new Date(), updatedAt: new Date() } }
    );
  }

  console.log(`Seeded "${ev.title}" with ${NAMES.length} participants.`);
  console.log(`  ${appConfig.basePath}/e/${ev.slug}`);
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
