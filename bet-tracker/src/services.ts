import { appConfig } from './config.js';
import type { Db } from './db/client.js';
import { createProviders } from './gamestate/registry.js';
import type { Services } from './mcp/server.js';
import { OddsApiClient } from './odds/oddsApi.js';
import { OddsPapiClient } from './odds/oddsPapi.js';
import { PapiLookups } from './odds/papiLookups.js';
import { OddsPapiProvider } from './odds/provider.js';
import { NtfyNotifier } from './scores/ntfy.js';
import { ScoreService } from './scores/service.js';
import { LiveMarketCheck } from './tracker/liveMarket.js';
import { Tracker } from './tracker/tracker.js';

/** Wire the real providers, odds client and tracker around a database. */
export function createServices(db: Db): Services {
  const providers = createProviders();
  const odds = new OddsApiClient(db, appConfig.oddsApi);
  // One client, so the per-endpoint cooldowns hold across closes and tools.
  const papiClient = new OddsPapiClient(appConfig.oddsPapi);
  const papiLookups = new PapiLookups(db, papiClient);
  const tracker = new Tracker(db, providers, {
    params: appConfig.models,
    props: appConfig.props,
    polling: appConfig.polling,
    pregameSnapshot: {
      client: odds,
      enabled: appConfig.oddsApi.pregameSnapshot,
      leadMinutes: appConfig.oddsApi.pregameSnapshotLeadMinutes,
    },
    clv: {
      client: odds,
      ...appConfig.oddsApi.clv,
      papi: papiClient,
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
    liveMarket: new LiveMarketCheck(
      odds,
      appConfig.models,
      appConfig.oddsApi.liveMarket
    ),
    confirmAboveCost: appConfig.oddsApi.confirmAboveCost,
    papi: {
      client: papiClient,
      lookups: papiLookups,
      provider: new OddsPapiProvider(db, papiClient, papiLookups, {
        sharpBook: appConfig.oddsPapi.sharpBook,
      }),
    },
  };
}
