// Dev check against the real providers: seed an in-memory DB, match every
// leg, run one tracker tick, and print each bet's live value.
// Run after a build: bin/dev node scripts/live-smoke.mjs
import { openDb } from '../built/db/client.js';
import { listBets } from '../built/db/bets.js';
import { loadSeed } from '../built/seed/load.js';
import { createProviders } from '../built/gamestate/registry.js';
import { matchLegs } from '../built/matching/service.js';
import { Tracker } from '../built/tracker/tracker.js';
import { valueBetRow } from '../built/tracker/valuation.js';

const db = openDb(':memory:');
loadSeed(db);
const providers = createProviders();
const out = await matchLegs(db, providers);
console.log(
  'matched',
  out.filter((o) => o.status === 'matched').length,
  'of',
  out.length
);
const tracker = new Tracker(db, providers, {
  params: {
    football: {
      nfl: { marginSigma: 13.5, totalSigma: 13, sigmaRange: [10, 16] },
      ncaaf: { marginSigma: 15, totalSigma: 14, sigmaRange: [11, 20] },
    },
    wnba: { marginSigma: 11.5, totalSigma: 15, sigmaRange: [8, 16] },
  },
  polling: { liveSeconds: 30, scheduledSeconds: 600 },
});
const r = await tracker.tick();
console.log('polled', r.polled.length, 'events; errors:', r.errors);
const usd = (c) => `$${(c / 100).toFixed(2)}`;
const pct = (p) =>
  p == null ? '  -  ' : `${(p * 100).toFixed(1)}%`.padStart(6);
for (const { bet, legs } of listBets(db)) {
  const v = valueBetRow(bet, legs);
  console.log(
    `#${bet.id} ${bet.status.padEnd(4)} P(win) ${pct(v.now.pWin)} value ${usd(v.now.valueCents).padStart(10)} EV ${usd(v.now.evCents).padStart(10)}` +
      (v.atPlacement
        ? ` | at placement ${pct(v.atPlacement.pWin)} EV ${usd(v.atPlacement.evCents)}`
        : '')
  );
  for (const l of legs) {
    console.log(
      `     ${l.status.padEnd(4)} ${pct(l.pWin)} ${l.eventLabel} ${l.selectionTeam ?? l.selectionKind} ${l.line ?? ''} [${l.model}; prior ${l.priorSource}]`
    );
  }
}
