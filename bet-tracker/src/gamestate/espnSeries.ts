import type { Side, Sport } from '../domain/types.js';
import { CONFIDENT, nameScore } from '../matching/match.js';
import { devig } from '../odds/math.js';
import {
  ESPN_BASE,
  espnPath,
  gameStatus,
  pregameLines,
  type EspnProvider,
  type EspnStatus,
} from './espn.js';
import { fetchJson } from './http.js';
import type { Fetcher, SeriesGame, SeriesState } from './types.js';

// Playoff series from ESPN team schedules. ESPN has no series id: a series
// is the postseason games between two teams in one season (they meet at
// most once), read from one team's `/teams/{id}/schedule?seasontype=3`,
// which lists every game including the "If Necessary" ones with their
// hosts. Its id is "espn:<sport>:series:<season>:<lower team id>-<higher>".

const CANDIDATE_FLOOR = 0.5;
const TEAMS_TTL_MS = 24 * 3600_000;
/** A series must have a game within this many days of the leg's date. */
const DATE_WINDOW_DAYS = 30;

export const seriesIdFor = (
  sport: Sport,
  season: number,
  a: string,
  b: string
) => {
  const [lo, hi] = [a, b].sort((x, y) => Number(x) - Number(y));
  return `espn:${sport}:series:${season}:${lo}-${hi}`;
};

export interface EspnTeam {
  id: string;
  name: string;
  abbr: string | null;
  aliases: string[];
}

interface ScheduleCompetitor {
  id?: string;
  homeAway?: 'home' | 'away';
  winner?: boolean;
  score?: string | { value?: number; displayValue?: string };
  team?: {
    id: string;
    abbreviation?: string;
    displayName: string;
    shortDisplayName?: string;
    location?: string;
  };
}

/** The parts of an ESPN team schedule we read. */
export interface EspnTeamSchedule {
  season?: { year?: number };
  events?: {
    id: string;
    date: string;
    season?: { year?: number };
    seasonType?: { type?: number };
    competitions?: {
      id: string;
      date?: string;
      status?: EspnStatus;
      notes?: { headline?: string }[];
      competitors?: ScheduleCompetitor[];
    }[];
  }[];
}

/** A series as found for matching: enough to create its row. */
export interface SeriesListing {
  id: string;
  sport: Sport;
  season: number;
  title: string | null;
  bestOf: number;
  home: { id: string; name: string; abbr: string | null };
  away: { id: string; name: string; abbr: string | null };
  startTime: string;
}

const scoreOf = (c: ScheduleCompetitor) => {
  const v =
    typeof c.score === 'object'
      ? (c.score.value ?? Number(c.score.displayValue))
      : Number(c.score);
  return Number.isFinite(v) ? Number(v) : null;
};

/** "World Series - Game 5 If Necessary" -> title, game number. */
function parseNote(headline: string | undefined) {
  const m = headline?.match(/^(.*?)\s*-\s*Game\s+(\d+)(.*)$/i);
  return m
    ? {
        title: m[1]!.trim() || null,
        number: Number(m[2]),
        ifNecessary: /if necessary/i.test(m[3]!),
      }
    : null;
}

/**
 * Best of how many: the highest game number ESPN lists, or the MLB round's
 * length from its title when it lists fewer.
 */
function bestOfFor(sport: Sport, title: string | null, maxListed: number) {
  let byTitle = 0;
  if (sport === 'mlb' && title) {
    if (/wild\s*card/i.test(title)) byTitle = 3;
    else if (/division|ALDS|NLDS/i.test(title)) byTitle = 5;
    else byTitle = 7;
  }
  const n = Math.max(maxListed, byTitle);
  return n % 2 === 1 ? n : n + 1;
}

/**
 * The series between teams `a` and `b` from one team's postseason
 * schedule, or null if they have no postseason games.
 */
export function parseSeries(
  sport: Sport,
  schedule: EspnTeamSchedule,
  a: string,
  b: string,
  fetchedAt: string
): SeriesState | null {
  const pair = new Set([a, b]);
  const rows: {
    game: Omit<SeriesGame, 'number'> & { number: number | null };
    title: string | null;
    season: number | null;
    teams: Map<string, NonNullable<ScheduleCompetitor['team']>>;
  }[] = [];
  for (const ev of schedule.events ?? []) {
    if (ev.seasonType?.type != null && ev.seasonType.type !== 3) continue;
    const c = ev.competitions?.[0];
    const cs = c?.competitors ?? [];
    const ids = cs.map((x) => x.team?.id ?? x.id);
    if (cs.length !== 2 || !ids.every((id) => id && pair.has(id))) continue;
    if (ids[0] === ids[1]) continue;
    const home = cs.find((x) => x.homeAway === 'home') ?? cs[0]!;
    const away = cs.find((x) => x !== home)!;
    const st = c!.status
      ? gameStatus(c!.status)
      : { status: 'pre' as const, cancelled: false };
    const note = parseNote(c!.notes?.[0]?.headline);
    const winner = cs.find((x) => x.winner)?.team?.id ?? null;
    rows.push({
      game: {
        id: c!.id,
        number: note?.number ?? null,
        startTime: new Date(c!.date ?? ev.date).toISOString(),
        homeTeamId: home.team?.id ?? home.id!,
        status: st.status,
        cancelled: st.cancelled,
        winnerTeamId: st.status === 'final' && !st.cancelled ? winner : null,
        homeScore: scoreOf(home),
        awayScore: scoreOf(away),
        ifNecessary: note?.ifNecessary ?? false,
        detail: c!.status?.type.shortDetail ?? '',
      },
      title: note?.title ?? null,
      season: ev.season?.year ?? null,
      teams: new Map(cs.map((x) => [x.team!.id, x.team!])),
    });
  }
  if (!rows.length) return null;
  rows.sort((x, y) => x.game.startTime.localeCompare(y.game.startTime));
  // Postponed games stay listed; a series never has two games with the same
  // number, so number by order where ESPN gives none.
  const games: SeriesGame[] = rows
    .filter((r) => !r.game.cancelled)
    .map((r, i) => ({ ...r.game, number: r.game.number ?? i + 1 }));
  const first = games.find((g) => g.number === 1) ?? games[0]!;
  const homeId = first.homeTeamId;
  const awayId = homeId === a ? b : a;
  const teams = rows[0]!.teams;
  const team = (id: string) => {
    const t = teams.get(id)!;
    return { id, name: t.displayName, abbr: t.abbreviation ?? null };
  };
  const title = rows.find((r) => r.title)?.title ?? null;
  const bestOf = bestOfFor(
    sport,
    title,
    Math.max(...games.map((g) => g.number))
  );
  const need = Math.floor(bestOf / 2) + 1;
  const wins = (id: string) =>
    games.filter((g) => g.winnerTeamId === id).length;
  const homeWins = wins(homeId);
  const awayWins = wins(awayId);
  const winner: Side | null =
    homeWins >= need ? 'home' : awayWins >= need ? 'away' : null;
  // The clinching game: the one that brought the winner to `need`.
  let decidedAt: string | null = null;
  if (winner) {
    const wid = winner === 'home' ? homeId : awayId;
    let n = 0;
    for (const g of games.filter((x) => x.status === 'final')) {
      if (g.winnerTeamId === wid && ++n === need) decidedAt = g.startTime;
    }
  }
  const season = rows.find((r) => r.season)?.season ?? schedule.season?.year;
  return {
    seriesId: seriesIdFor(sport, season ?? 0, a, b),
    sport,
    title,
    bestOf,
    home: { ...team(homeId), wins: homeWins },
    away: { ...team(awayId), wins: awayWins },
    games,
    status: winner
      ? 'final'
      : games.some((g) => g.status !== 'pre')
        ? 'in'
        : 'pre',
    winner,
    decidedAt,
    fetchedAt,
  };
}

export type SeriesMatch =
  | { status: 'matched'; series: SeriesListing; sides: [Side, Side] }
  | {
      status: 'needs_confirmation';
      candidates: {
        series: SeriesListing;
        sides: [Side, Side];
        score: number;
      }[];
    }
  | { status: 'unmatched' };

const toListing = (s: SeriesState, season: number): SeriesListing => ({
  id: s.seriesId,
  sport: s.sport,
  season,
  title: s.title,
  bestOf: s.bestOf,
  home: { id: s.home.id, name: s.home.name, abbr: s.home.abbr },
  away: { id: s.away.id, name: s.away.name, abbr: s.away.abbr },
  startTime: s.games[0]!.startTime,
});

/** The series' row fields a state fetch needs. */
export interface SeriesRef {
  id: string;
  sport: Sport;
  homeTeamId: string;
  awayTeamId: string;
}

export class EspnSeriesProvider {
  private teamCache = new Map<Sport, { at: number; teams: EspnTeam[] }>();

  constructor(
    private readonly espn: EspnProvider,
    private readonly fetcher: Fetcher = fetchJson
  ) {}

  /** Every team in a sport with its ESPN id (cached a day). */
  async teams(sport: Sport): Promise<EspnTeam[]> {
    const hit = this.teamCache.get(sport);
    if (hit && Date.now() - hit.at < TEAMS_TTL_MS) return hit.teams;
    const res = (await this.fetcher(
      `${ESPN_BASE}/${espnPath(sport)}/teams?limit=1000`
    )) as {
      sports?: {
        leagues?: { teams?: { team: ScheduleCompetitor['team'] }[] }[];
      }[];
    };
    const teams = (res.sports?.[0]?.leagues?.[0]?.teams ?? []).flatMap(
      ({ team: t }) =>
        t
          ? [
              {
                id: t.id,
                name: t.displayName,
                abbr: t.abbreviation ?? null,
                aliases: [
                  t.displayName,
                  t.shortDisplayName,
                  t.location,
                  t.abbreviation,
                ].filter((x): x is string => !!x),
              },
            ]
          : []
    );
    if (teams.length) this.teamCache.set(sport, { at: Date.now(), teams });
    return teams;
  }

  private schedule(sport: Sport, teamId: string): Promise<EspnTeamSchedule> {
    return this.fetcher(
      `${ESPN_BASE}/${espnPath(sport)}/teams/${teamId}/schedule?seasontype=3`
    ) as Promise<EspnTeamSchedule>;
  }

  /**
   * The playoff series between two entered team names. Never guesses: both
   * names must match one team confidently and the two must have postseason
   * games near `date`; otherwise every plausible pairing with games comes
   * back as a candidate.
   */
  async findSeries(
    sport: Sport,
    participants: [string, string],
    date: string
  ): Promise<SeriesMatch> {
    const teams = await this.teams(sport);
    const ranked = participants.map((p) =>
      teams
        .map((t) => ({ t, score: nameScore(p, t.aliases) }))
        .filter((x) => x.score >= CANDIDATE_FLOOR)
        .sort((x, y) => y.score - x.score)
        .slice(0, 3)
    ) as [{ t: EspnTeam; score: number }[], { t: EspnTeam; score: number }[]];
    const found: {
      series: SeriesListing;
      sides: [Side, Side];
      score: number;
    }[] = [];
    const day = new Date(`${date}T12:00:00Z`).getTime();
    for (const x of ranked[0]) {
      const sched = await this.schedule(sport, x.t.id);
      for (const y of ranked[1]) {
        if (x.t.id === y.t.id) continue;
        const s = parseSeries(
          sport,
          sched,
          x.t.id,
          y.t.id,
          new Date().toISOString()
        );
        if (!s) continue;
        const near = s.games.some(
          (g) =>
            Math.abs(new Date(g.startTime).getTime() - day) <=
            DATE_WINDOW_DAYS * 86_400_000
        );
        if (!near) continue;
        const season = Number(s.seriesId.split(':')[3]);
        found.push({
          series: toListing(s, season),
          sides: [
            x.t.id === s.home.id ? 'home' : 'away',
            y.t.id === s.home.id ? 'home' : 'away',
          ],
          score: Math.min(x.score, y.score),
        });
      }
    }
    found.sort((p, q) => q.score - p.score);
    const confident = found.filter((f) => f.score >= CONFIDENT);
    if (confident.length === 1) return { status: 'matched', ...confident[0]! };
    if (!found.length) return { status: 'unmatched' };
    return { status: 'needs_confirmation', candidates: found.slice(0, 5) };
  }

  /**
   * A series now, with ESPN's live win probability for a game in progress
   * and the de-vigged moneyline of the game in progress or next up (P(its
   * host wins)), for the per-game strength.
   */
  async getState(ref: SeriesRef): Promise<{
    state: SeriesState;
    line: { gameId: string; number: number; pHost: number } | null;
  } | null> {
    const fetchedAt = new Date().toISOString();
    const sched = await this.schedule(ref.sport, ref.homeTeamId);
    const state = parseSeries(
      ref.sport,
      sched,
      ref.homeTeamId,
      ref.awayTeamId,
      fetchedAt
    );
    if (!state) return null;
    if (state.status === 'final') return { state, line: null };
    const played = state.home.wins + state.away.wins;
    const current =
      state.games.find((g) => g.status === 'in') ??
      state.games.find((g) => g.number === played + 1 && g.status === 'pre');
    if (!current) return { state, line: null };
    const summary = await this.espn.fetchSummary(ref.sport, null, current.id);
    if (current.status === 'in') {
      const wp = summary.winprobability?.at(-1)?.homeWinPercentage;
      current.liveHomeWinProb = typeof wp === 'number' ? wp : null;
    }
    const lines = pregameLines(summary.pickcenter);
    const line =
      lines?.homeMoneyline != null && lines.awayMoneyline != null
        ? {
            gameId: current.id,
            number: current.number,
            pHost: devig([lines.homeMoneyline, lines.awayMoneyline]).fair[0]!,
          }
        : null;
    return { state, line };
  }
}
