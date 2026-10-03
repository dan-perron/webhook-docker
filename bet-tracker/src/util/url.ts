import { appConfig } from '../config.js';

/** Configured sub-path the app is served under ('' when at root). */
export const basePath = appConfig.basePath;

/**
 * Prefix an app-absolute path (must start with '/') with the configured base
 * path so links/forms/HTMX/static URLs work when served under a sub-path.
 * `url('/events')` -> '/events' at root, '/bets/events' under BASE_PATH=/bets.
 */
export function url(path: string): string {
  return basePath + path;
}
