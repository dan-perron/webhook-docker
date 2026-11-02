import { appConfig } from '../config.js';

/** Configured sub-path the app is served under ('' when at root). */
export const basePath = appConfig.basePath;

/**
 * Prefix an app-absolute path (must start with '/') with the configured base
 * path. `url('/oauth/token')` -> '/mcp/oauth/token' under BASE_PATH=/mcp.
 */
export function url(path: string): string {
  return basePath + path;
}
