import { appConfig } from '../config.js';

/** Configured sub-path the app is served under ('' when at root). */
export const basePath = appConfig.basePath;

/** The app's root URL: '/recipes' (no trailing slash, which would 301), or '/'. */
export const home = basePath || '/';

/**
 * Prefix an app-absolute path (must start with '/') with the configured base
 * path so links/forms/HTMX/static URLs work when served under a sub-path.
 * `url('/r/chili')` -> '/recipes/r/chili' under BASE_PATH=/recipes.
 */
export function url(path: string): string {
  return basePath + path;
}
