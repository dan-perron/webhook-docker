import config from 'config';

/** Centralized, typed access to the `config` package values. */
export const appConfig = {
  port: Number(config.get<number | string>('port')),
  basePath: config.get<string>('basePath'),
  mongo: config.get<{ uri: string; database: string }>('mongo'),
  timezone: config.get<string>('timezone'),
  auth: {
    appToken: config.get<string>('auth.appToken'),
  },
  maxRangeDays: Number(config.get<number>('maxRangeDays')),
};
