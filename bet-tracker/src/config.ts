import config from 'config';

interface FootballSigmas {
  marginSigma: number;
  totalSigma: number;
}

/** Centralized, typed access to the `config` package values. */
export const appConfig = {
  port: Number(config.get<number | string>('port')),
  basePath: config.get<string>('basePath'),
  publicOrigin: config.get<string>('publicOrigin'),
  databasePath: config.get<string>('databasePath'),
  timezone: config.get<string>('timezone'),
  auth: {
    appToken: config.get<string>('auth.appToken'),
    extraRedirectUris: config.get<string[]>('auth.extraRedirectUris'),
  },
  oddsApi: {
    apiKey: config.get<string>('oddsApi.apiKey'),
    baseUrl: config.get<string>('oddsApi.baseUrl'),
    cacheSeconds: config.get<number>('oddsApi.cacheSeconds'),
    confirmAboveCost: config.get<number>('oddsApi.confirmAboveCost'),
    pregameSnapshot: config.get<boolean>('oddsApi.pregameSnapshot'),
    pregameSnapshotLeadMinutes: config.get<number>(
      'oddsApi.pregameSnapshotLeadMinutes'
    ),
    regions: config.get<string>('oddsApi.regions'),
  },
  polling: {
    liveSeconds: config.get<number>('polling.liveSeconds'),
    scheduledSeconds: config.get<number>('polling.scheduledSeconds'),
  },
  models: {
    football: {
      nfl: config.get<FootballSigmas>('models.football.nfl'),
      ncaaf: config.get<FootballSigmas>('models.football.ncaaf'),
    },
    mlb: { simulations: config.get<number>('models.mlb.simulations') },
  },
};
