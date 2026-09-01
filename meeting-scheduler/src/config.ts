import config from 'config';

/** Centralized, typed access to the `config` package values. */
export const appConfig = {
  port: Number(config.get<number | string>('port')),
  basePath: config.get<string>('basePath'),
  mongo: {
    connectionString: config.get<string>('mongodb.connectionString'),
    database: config.get<string>('mongodb.database'),
  },
  defaultTimezone: config.get<string>('defaultTimezone'),
  cookieSecure: config.get<boolean>('cookieSecure'),
  publicOrigin: config.get<string>('publicOrigin'),
  assetVersion: config.get<string>('assetVersion'),
};
