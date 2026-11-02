import config from 'config';
import type { RecommendParams } from './domain/recommend.js';

/** Centralized, typed access to the `config` package values. */
export const appConfig = {
  port: Number(config.get<number | string>('port')),
  basePath: config.get<string>('basePath'),
  publicOrigin: config.get<string>('publicOrigin'),
  mongo: config.get<{ uri: string; database: string }>('mongo'),
  timezone: config.get<string>('timezone'),
  auth: {
    password: config.get<string>('auth.password'),
    appToken: config.get<string>('auth.appToken'),
    cookieSecure: config.get<boolean>('auth.cookieSecure'),
  },
  recommend: config.get<RecommendParams>('recommend'),
};
