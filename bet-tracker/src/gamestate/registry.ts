import type { Sport } from '../domain/types.js';
import { matchEvent } from '../matching/match.js';
import { localDate } from '../util/date.js';
import { appConfig } from '../config.js';
import { NflWatchGuide } from './nflWatch.js';
import { EspnProvider } from './espn.js';
import { EspnSeriesProvider } from './espnSeries.js';
import { MlbStatsProvider } from './mlbStats.js';
import type {
  Fetcher,
  GameStateProvider,
  PlayerStats,
  PregameLines,
} from './types.js';

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
  /**
   * Player box score and touchdowns (player props), from the ESPN summary.
   * MLB events come from the Stats API, so they are found on ESPN by teams
   * and date (once per event). Null when ESPN has no box score yet.
   */
  playerStats(event: LinesTarget): Promise<PlayerStats | null>;
  /** Playoff series (series markets), from ESPN team schedules. */
  series: EspnSeriesProvider;
}

/** MLB from the Stats API (richer base/out state); everything else ESPN. */
export function createProviders(fetcher?: Fetcher): Providers {
  const espn = new EspnProvider(
    fetcher,
    undefined,
    fetcher ? undefined : new NflWatchGuide(appConfig.viewingLocation)
  );
  const mlb = new MlbStatsProvider(fetcher);
  const series = new EspnSeriesProvider(espn, fetcher);
  const byName: Record<string, GameStateProvider> = { espn, mlb };
  // Non-ESPN events -> their ESPN competition (league, id), found once.
  const espnIds = new Map<string, { league: string | null; id: string }>();
  const espnEvent = async (event: LinesTarget) => {
    if (event.provider === 'espn')
      return { league: event.league, id: event.providerEventId };
    const hit = espnIds.get(event.id);
    if (hit) return hit;
    const listed = await espn.listEvents(
      event.sport,
      localDate(event.startTime)
    );
    const r = matchEvent([event.homeName, event.awayName], listed);
    if (r.status !== 'matched' || r.candidate.sides[0] !== 'home') return null;
    const found = {
      league: r.candidate.event.league,
      id: r.candidate.event.providerEventId,
    };
    espnIds.set(event.id, found);
    return found;
  };
  return {
    series,
    forSport: (sport) => (sport === 'mlb' ? mlb : espn),
    forEventId: (id) => {
      const p = byName[id.split(':')[0]!];
      if (!p) throw new Error(`No provider for event ${id}`);
      return p;
    },
    async playerStats(event) {
      const e = await espnEvent(event);
      return e ? espn.fetchPlayerStats(event.sport, e.league, e.id) : null;
    },
    async pregameLines(event) {
      if (event.sport === 'mma') return null; // ESPN publishes no fight odds
      const e = await espnEvent(event);
      return e ? espn.fetchLines(event.sport, e.league, e.id) : null;
    },
  };
}
