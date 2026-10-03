// Dev check against the real providers: seed an in-memory DB, match every
// leg, and print live state. Run after a build: bin/dev node scripts/live-smoke.mjs
import { openDb } from '../built/db/client.js';
import { loadSeed } from '../built/seed/load.js';
import { createProviders } from '../built/gamestate/registry.js';
import { matchLegs } from '../built/matching/service.js';
import { events } from '../built/db/schema.js';
const db = openDb(':memory:');
loadSeed(db);
const p = createProviders();
const out = await matchLegs(db, p);
console.log(
  'matched',
  out.filter((o) => o.status === 'matched').length,
  'of',
  out.length
);
for (const o of out.filter((o) => o.status !== 'matched'))
  console.log('NOT', o);
const rows = db.select().from(events).all();
const byProv = {};
for (const r of rows)
  (byProv[r.provider] ??= []).push({
    id: r.id,
    sport: r.sport,
    league: r.league,
    startTime: r.startTime,
  });
for (const refs of Object.values(byProv)) {
  const states = await p.forEventId(refs[0].id).getStates(refs);
  for (const s of states.values())
    console.log(
      s.status.padEnd(5),
      s.eventId.padEnd(22),
      `${s.away.name} ${s.away.score} @ ${s.home.name} ${s.home.score}`,
      '|',
      s.detail,
      s.situation ? JSON.stringify(s.situation) : ''
    );
}
