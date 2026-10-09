import { appConfig } from './config.js';
import type { Db } from './db/client.js';
import { createProviders } from './gamestate/registry.js';
import type { Services } from './mcp/server.js';
import { OddsApiClient } from './odds/oddsApi.js';
import { NtfyNotifier } from './scores/ntfy.js';
import { ScoreService } from './scores/service.js';
import { Tracker } from './tracker/tracker.js';

/** Wire the real providers, odds client and tracker around a database. */
export function createServices(db: Db): Services {
  const providers = createProviders();
  const odds = new OddsApiClient(db, appConfig.oddsApi);
  const tracker = new Tracker(db, providers, {
    params: appConfig.models,
    polling: appConfig.polling,
    pregameSnapshot: {
      client: odds,
      enabled: appConfig.oddsApi.pregameSnapshot,
      leadMinutes: appConfig.oddsApi.pregameSnapshotLeadMinutes,
    },
  });
  const { alerts, ...scoreOpts } = appConfig.scores;
  const scores = new ScoreService(db, providers, tracker, {
    ...scoreOpts,
    notifier: new NtfyNotifier(alerts.ntfyUrl, alerts.ntfyToken),
    quietHours: alerts.quietHours,
    timeZone: appConfig.timezone,
    clickUrl: `${appConfig.publicOrigin}${appConfig.basePath}/scores`,
  });
  return {
    db,
    providers,
    tracker,
    scores,
    odds,
    confirmAboveCost: appConfig.oddsApi.confirmAboveCost,
  };
}
