import type { Db } from '../../src/db/client.js';
import type { Providers } from '../../src/gamestate/registry.js';
import type { AlertKind } from '../../src/scores/alerts.js';
import type { Notifier } from '../../src/scores/ntfy.js';
import { ScoreService } from '../../src/scores/service.js';
import type { Tracker } from '../../src/tracker/tracker.js';

export interface Sent {
  kind: AlertKind;
  title: string;
  body: string;
}

/** A notifier that records what it would have pushed. */
export function recordingNotifier(configured = true) {
  const sent: Sent[] = [];
  const notifier: Notifier = {
    configured,
    async send(n) {
      sent.push({ kind: n.kind, title: n.title, body: n.body });
    },
  };
  return { notifier, sent };
}

export function scoreService(
  db: Db,
  providers: Providers,
  tracker: Tracker,
  opts: { now?: () => Date; notifier?: Notifier; quietHours?: string } = {}
) {
  return new ScoreService(db, providers, tracker, {
    followDays: 7,
    finalHours: 18,
    notifier: opts.notifier ?? recordingNotifier(false).notifier,
    quietHours: opts.quietHours ?? '',
    timeZone: 'America/Chicago',
    now: opts.now,
  });
}
