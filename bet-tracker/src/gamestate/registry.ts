import type { Sport } from '../domain/types.js';
import { EspnProvider } from './espn.js';
import { MlbStatsProvider } from './mlbStats.js';
import type { Fetcher, GameStateProvider } from './types.js';

export interface Providers {
  /** The provider used to match and poll a sport. */
  forSport(sport: Sport): GameStateProvider;
  /** The provider that owns an event id ("espn:..." / "mlb:..."). */
  forEventId(id: string): GameStateProvider;
}

/** MLB from the Stats API (richer base/out state); everything else ESPN. */
export function createProviders(fetcher?: Fetcher): Providers {
  const espn = new EspnProvider(fetcher);
  const mlb = new MlbStatsProvider(fetcher);
  const byName: Record<string, GameStateProvider> = { espn, mlb };
  return {
    forSport: (sport) => (sport === 'mlb' ? mlb : espn),
    forEventId: (id) => {
      const p = byName[id.split(':')[0]!];
      if (!p) throw new Error(`No provider for event ${id}`);
      return p;
    },
  };
}
