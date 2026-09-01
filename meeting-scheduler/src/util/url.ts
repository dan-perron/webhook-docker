import { appConfig } from '../config.js';

/** Configured sub-path the app is served under ('' when at root). */
export const basePath = appConfig.basePath;

/**
 * Prefix an app-absolute path (must start with '/') with the configured base
 * path so links/forms/fetch/static URLs work when served under a sub-path.
 * `url('/e/abc')` -> '/e/abc' at root, '/meet/e/abc' under BASE_PATH=/meet.
 */
export function url(path: string): string {
  return basePath + path;
}

/**
 * Same as `url()` but version-stamped, for static assets. Without this a cached
 * grid.js survives a deploy and you spend an afternoon chasing a fixed bug.
 */
export function asset(path: string): string {
  return `${basePath}${path}?v=${appConfig.assetVersion}`;
}
