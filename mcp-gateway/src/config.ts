import config from 'config';
import type { Backend } from './mcp/backends.js';

/** Centralized, typed access to the `config` package values. */
export const appConfig = {
  port: Number(config.get<number | string>('port')),
  basePath: config.get<string>('basePath'),
  publicOrigin: config.get<string>('publicOrigin'),
  mongo: config.get<{ uri: string; database: string }>('mongo'),
  auth: {
    appToken: config.get<string>('auth.appToken'),
    extraRedirectUris: config.get<string[]>('auth.extraRedirectUris'),
  },
  backends: config.get<Backend[]>('backends'),
  discoveryCacheSeconds: config.get<number>('discoveryCacheSeconds'),
};
