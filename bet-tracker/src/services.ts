import { appConfig } from './config.js';
import type { Db } from './db/client.js';
import { createProviders } from './gamestate/registry.js';
import type { Services } from './mcp/server.js';
import { OddsApiClient } from './odds/oddsApi.js';
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
  return {
    db,
    providers,
    tracker,
    odds,
    confirmAboveCost: appConfig.oddsApi.confirmAboveCost,
  };
}
