import type { GameStatus, Sport } from '../domain/types.js';
import { addDays, localDate } from '../util/date.js';
import { fetchJson } from './http.js';
import type {
  BaseballSituation,
  EventRef,
  Fetcher,
  GameState,
  GameStateProvider,
  ProviderEvent,
  TeamListing,
} from './types.js';

// MLB Stats API. The batch schedule endpoint with hydrate=linescore returns
// the same linescore object as /feed/live (inning, half, outs, runners,
// score) for every requested game in one ~4 KB/game response, so one call
// covers all tracked games instead of a ~650 KB feed per game.

const BASE = 'https://statsapi.mlb.com/api/v1';

interface MlbLinescore {
  currentInning?: number;
  inningState?: 'Top' | 'Middle' | 'Bottom' | 'End';
  isTopInning?: boolean;
  scheduledInnings?: number;
  outs?: number;
  offense?: { first?: unknown; second?: unknown; third?: unknown };
  teams?: { home?: { runs?: number }; away?: { runs?: number } };
}

interface MlbTeamSide {
  team: { id: number; name: string; abbreviation?: string; teamName?: string };
  score?: number;
  isWinner?: boolean;
}

interface MlbGame {
  gamePk: number;
  /** R = regular season; F/D/L/W = postseason rounds. */
  gameType?: string;
  gameDate: string;
  status: {
    abstractGameState: string;
    /** P = pre-game (incl. "Warmup", which is abstractly Live), S = scheduled. */
    codedGameState?: string;
    detailedState: string;
  };
  teams: { home: MlbTeamSide; away: MlbTeamSide };
  linescore?: MlbLinescore;
  scheduledInnings?: number;
  /** With hydrate=gameInfo; durations are filled in once the game is over. */
  gameInfo?: {
    firstPitch?: string;
    gameDurationMinutes?: number;
    delayDurationMinutes?: number;
  };
}

export interface MlbSchedule {
  dates?: { games: MlbGame[] }[];
}

const eventId = (gamePk: number | string) => `mlb:${gamePk}`;

function gameStatus(g: MlbGame): { status: GameStatus; cancelled: boolean } {
  const detailed = g.status.detailedState;
  if (/Postponed|Cancelled|Canceled/i.test(detailed)) {
    return { status: 'final', cancelled: true };
  }
  if (g.status.abstractGameState === 'Final') {
    return { status: 'final', cancelled: false };
  }
  // "Warmup" reports abstractGameState Live but coded state P: not started.
  if (
    g.status.abstractGameState === 'Live' &&
    g.status.codedGameState !== 'P'
  ) {
    return { status: 'in', cancelled: false };
  }
  return { status: 'pre', cancelled: false };
}

/** Normalize to the half-inning being (or next to be) played. */
export function situationFromLinescore(
  ls: MlbLinescore,
  scheduled = 9,
  regularSeason = true
): BaseballSituation {
  let inning = ls.currentInning ?? 1;
  const state = ls.inningState ?? (ls.isTopInning === false ? 'Bottom' : 'Top');
  let half: 'top' | 'bottom' =
    state === 'Top' || state === 'End' ? 'top' : 'bottom';
  let live = state === 'Top' || state === 'Bottom';
  if (state === 'End') inning += 1;
  const outs = ls.outs ?? 0;
  if (live && outs >= 3) {
    live = false;
    if (half === 'top') half = 'bottom';
    else {
      half = 'top';
      inning += 1;
    }
  }
  return {
    kind: 'baseball',
    inning,
    half,
    outs: live ? outs : 0,
    first: live && ls.offense?.first != null,
    second: live && ls.offense?.second != null,
    third: live && ls.offense?.third != null,
    scheduledInnings: ls.scheduledInnings ?? scheduled,
    extraInningRunner: regularSeason,
  };
}

function detail(
  g: MlbGame,
  status: GameStatus,
  sit: BaseballSituation | null
): string {
  if (status === 'final')
    return g.status.detailedState === 'Game Over'
      ? 'Final'
      : g.status.detailedState;
  if (status === 'pre' || !sit) return g.status.detailedState;
  const ord = (n: number) => {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
  };
  const ls = g.linescore;
  if (ls?.inningState === 'Middle' || ls?.inningState === 'End') {
    return `${ls.inningState === 'Middle' ? 'Mid' : 'End'} ${ord(ls.currentInning ?? 1)}`;
  }
  return `${sit.half === 'top' ? 'Top' : 'Bot'} ${ord(sit.inning)}, ${sit.outs} out`;
}

export function parseSchedule(
  sched: MlbSchedule,
  fetchedAt = new Date().toISOString()
): GameState[] {
  const out: GameState[] = [];
  for (const d of sched.dates ?? []) {
    for (const g of d.games) {
      const { status, cancelled } = gameStatus(g);
      const ls = g.linescore;
      const sit =
        status === 'in' && ls
          ? situationFromLinescore(
              ls,
              g.scheduledInnings,
              (g.gameType ?? 'R') === 'R'
            )
          : null;
      const homeRuns = ls?.teams?.home?.runs ?? g.teams.home.score ?? 0;
      const awayRuns = ls?.teams?.away?.runs ?? g.teams.away.score ?? 0;
      let fractionRemaining = status === 'pre' ? 1 : 0;
      if (sit) {
        const done =
          (sit.inning - 1) * 2 + (sit.half === 'bottom' ? 1 : 0) + sit.outs / 3;
        fractionRemaining = Math.max(0, 1 - done / (sit.scheduledInnings * 2));
      }
      let winner: GameState['winner'] = null;
      if (status === 'final' && !cancelled) {
        winner =
          homeRuns > awayRuns ? 'home' : awayRuns > homeRuns ? 'away' : 'draw';
      }
      const info = g.gameInfo;
      const endTime =
        status === 'final' &&
        !cancelled &&
        info?.firstPitch &&
        info.gameDurationMinutes != null
          ? new Date(
              new Date(info.firstPitch).getTime() +
                (info.gameDurationMinutes + (info.delayDurationMinutes ?? 0)) *
                  60_000
            ).toISOString()
          : null;
      out.push({
        eventId: eventId(g.gamePk),
        sport: 'mlb',
        status,
        cancelled,
        startTime: new Date(g.gameDate).toISOString(),
        home: {
          name: g.teams.home.team.name,
          abbr: g.teams.home.team.abbreviation ?? null,
          score: homeRuns,
        },
        away: {
          name: g.teams.away.team.name,
          abbr: g.teams.away.team.abbreviation ?? null,
          score: awayRuns,
        },
        period: sit?.inning ?? ls?.currentInning ?? null,
        clockSeconds: null,
        detail: detail(g, status, sit),
        fractionRemaining,
        situation: sit,
        winner,
        endTime,
        providerWinProb: null,
        fetchedAt,
      });
    }
  }
  return out;
}

export class MlbStatsProvider implements GameStateProvider {
  readonly name = 'mlb';
  readonly sports: readonly Sport[] = ['mlb'];

  constructor(private readonly fetcher: Fetcher = fetchJson) {}

  async listTeams(): Promise<TeamListing[]> {
    const res = (await this.fetcher(`${BASE}/teams?sportId=1`)) as {
      teams?: { name: string; teamName?: string; abbreviation?: string }[];
    };
    return (res.teams ?? []).map((t) => ({
      name: t.name,
      aliases: [t.name, t.teamName, t.abbreviation].filter(
        (v): v is string => !!v
      ),
    }));
  }

  async listEvents(_sport: Sport, date: string): Promise<ProviderEvent[]> {
    // Schedule dates are the US "official date"; read the next day too for
    // late local starts, then filter by local date.
    const out: ProviderEvent[] = [];
    for (const d of [date, addDays(date, 1)]) {
      const sched = (await this.fetcher(
        `${BASE}/schedule?sportId=1&date=${d}&hydrate=team`
      )) as MlbSchedule;
      for (const day of sched.dates ?? []) {
        for (const g of day.games) {
          const startTime = new Date(g.gameDate).toISOString();
          if (localDate(startTime) !== date) continue;
          const side = (t: MlbTeamSide) => ({
            name: t.team.name,
            abbr: t.team.abbreviation ?? null,
            aliases: [t.team.name, t.team.teamName, t.team.abbreviation].filter(
              (v): v is string => !!v
            ),
          });
          out.push({
            id: eventId(g.gamePk),
            sport: 'mlb',
            provider: 'mlb',
            providerEventId: String(g.gamePk),
            league: 'mlb',
            startTime,
            home: side(g.teams.home),
            away: side(g.teams.away),
            status: gameStatus(g).status,
            pregameLines: null,
          });
        }
      }
    }
    return out;
  }

  async getStates(refs: EventRef[]): Promise<Map<string, GameState>> {
    const states = new Map<string, GameState>();
    if (refs.length === 0) return states;
    const pks = refs.map((r) => r.id.replace(/^mlb:/, ''));
    const sched = (await this.fetcher(
      `${BASE}/schedule?sportId=1&gamePks=${pks.join(',')}&hydrate=linescore,team,gameInfo`
    )) as MlbSchedule;
    for (const s of parseSchedule(sched)) states.set(s.eventId, s);
    return states;
  }
}
