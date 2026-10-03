import type { Sport } from '../domain/types.js';
import { matchEvent } from '../matching/match.js';
import { localDate } from '../util/date.js';
import { EspnProvider } from './espn.js';
import { MlbStatsProvider } from './mlbStats.js';
import type { Fetcher, GameStateProvider, PregameLines } from './types.js';

/** The event fields needed to look up its lines. */
export interface LinesTarget {
  id: string;
  sport: Sport;
  provider: string;
  providerEventId: string;
  league: string | null;
  startTime: string;
  homeName: string;
  awayName: string;
}

export interface Providers {
  /** The provider used to match and poll a sport. */
  forSport(sport: Sport): GameStateProvider;
  /** The provider that owns an event id ("espn:..." / "mlb:..."). */
  forEventId(id: string): GameStateProvider;
  /**
   * Free pregame/closing lines for an event from ESPN (DraftKings). MLB events
   * come from the Stats API, so they are found on ESPN by teams and date.
   */
  pregameLines(event: LinesTarget): Promise<PregameLines | null>;
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
    async pregameLines(event) {
      if (event.sport === 'mma') return null; // ESPN publishes no fight odds
      if (event.provider === 'espn') {
        return espn.fetchLines(
          event.sport,
          event.league,
          event.providerEventId
        );
      }
      const listed = await espn.listEvents(
        event.sport,
        localDate(event.startTime)
      );
      const r = matchEvent([event.homeName, event.awayName], listed);
      if (r.status !== 'matched' || r.candidate.sides[0] !== 'home')
        return null;
      return espn.fetchLines(
        event.sport,
        r.candidate.event.league,
        r.candidate.event.providerEventId
      );
    },
  };
}
