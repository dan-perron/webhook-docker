import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Fetcher } from '../../src/gamestate/types.js';

const DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures'
);

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8')) as T;
}

/**
 * A Fetcher that serves recorded responses: `routes` maps a substring of the
 * URL to a fixture file; anything else gets an empty scoreboard/schedule.
 * Records every URL requested.
 */
export function fakeFetcher(routes: Record<string, string>) {
  const requested: string[] = [];
  const fetcher: Fetcher = async (url) => {
    requested.push(url);
    for (const [needle, file] of Object.entries(routes)) {
      if (url.includes(needle)) return fixture(file);
    }
    return url.includes('statsapi') ? { dates: [] } : { events: [] };
  };
  return { fetcher, requested };
}

/** Routes covering every seed leg's event. */
export const SEED_ROUTES = {
  'college-football/scoreboard?dates=20261003':
    'espn/ncaaf-20261003-afternoon.json',
  'football/nfl/scoreboard?dates=20261004': 'espn/nfl-20261004-pre.json',
  'mma/ufc/scoreboard?dates=20261003': 'espn/ufc-20261003-pre.json',
  'soccer/uefa.nations/scoreboard?dates=20261004':
    'espn/soccer-uefa.nations-20261004-pre.json',
  'statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-10-03':
    'mlb/schedule-20261003.json',
};
