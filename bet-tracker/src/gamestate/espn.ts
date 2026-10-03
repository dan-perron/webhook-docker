import type { GameStatus, Side, Sport } from '../domain/types.js';
import { addDays, compactDate, localDate } from '../util/date.js';
import { fetchJson } from './http.js';
import type {
  Competitor,
  EventRef,
  Fetcher,
  GameState,
  GameStateProvider,
  PregameLines,
  ProviderEvent,
  Situation,
} from './types.js';

// ESPN's public (unofficial) site API. One scoreboard call returns every game
// for a sport/league/date with status, score, situation and DraftKings
// pregame lines, so polling is batched per scoreboard, never per game.

const BASE = 'https://site.api.espn.com/apis/site/v2/sports';

/** Leagues searched for soccer events; matched events remember theirs. */
export const DEFAULT_SOCCER_LEAGUES = [
  'uefa.nations',
  'fifa.friendly',
  'fifa.worldq.uefa',
  'uefa.euroq',
  'uefa.champions',
  'eng.1',
  'esp.1',
  'ita.1',
  'ger.1',
  'fra.1',
  'usa.1',
  'mex.1',
];

const PATHS: Record<
  Exclude<Sport, 'soccer'>,
  { path: string; query: string; league: string }
> = {
  nfl: { path: 'football/nfl', query: '', league: 'nfl' },
  ncaaf: {
    path: 'football/college-football',
    query: '&groups=80&limit=300',
    league: 'college-football',
  },
  mlb: { path: 'baseball/mlb', query: '', league: 'mlb' },
  mma: { path: 'mma/ufc', query: '', league: 'ufc' },
};

// --- Minimal shapes of the ESPN JSON we read -------------------------------

interface EspnStatus {
  clock?: number;
  displayClock?: string;
  period?: number;
  type: {
    name: string;
    state: 'pre' | 'in' | 'post';
    completed: boolean;
    shortDetail?: string;
    detail?: string;
  };
}

interface EspnCompetitor {
  homeAway?: 'home' | 'away';
  order?: number;
  winner?: boolean;
  score?: string;
  team?: {
    id: string;
    location?: string;
    name?: string;
    abbreviation?: string;
    displayName: string;
    shortDisplayName?: string;
  };
  athlete?: { displayName: string; shortName?: string };
}

interface EspnOddsSide {
  close?: { odds?: string };
  open?: { odds?: string };
}

interface EspnOdds {
  provider?: { name?: string };
  spread?: number;
  overUnder?: number;
  moneyline?: { home?: EspnOddsSide; away?: EspnOddsSide; draw?: EspnOddsSide };
  homeTeamOdds?: { moneyLine?: number };
  awayTeamOdds?: { moneyLine?: number };
  drawOdds?: { moneyLine?: number };
}

interface EspnSituation {
  // football
  down?: number;
  distance?: number;
  yardLine?: number;
  possession?: string;
  possessionText?: string;
  downDistanceText?: string;
  lastPlay?: {
    probability?: {
      homeWinPercentage?: number;
      awayWinPercentage?: number;
      tiePercentage?: number;
    };
  };
  // baseball
  outs?: number;
  onFirst?: boolean;
  onSecond?: boolean;
  onThird?: boolean;
}

interface EspnCompetition {
  id: string;
  date?: string;
  startDate?: string;
  status?: EspnStatus;
  competitors: EspnCompetitor[];
  situation?: EspnSituation;
  odds?: EspnOdds[];
}

interface EspnEvent {
  id: string;
  date: string;
  /** type 2 = regular season, 3 = postseason. */
  season?: { type?: number };
  status: EspnStatus;
  competitions: EspnCompetition[];
}

export interface EspnScoreboard {
  events?: EspnEvent[];
}

// --- Parsing ----------------------------------------------------------------

const eventId = (sport: Sport, competitionId: string) =>
  `espn:${sport}:${competitionId}`;

function gameStatus(s: EspnStatus): { status: GameStatus; cancelled: boolean } {
  const name = s.type.name;
  if (/POSTPONED|CANCELED|CANCELLED|NO_CONTEST|FORFEIT|ABANDONED/.test(name)) {
    return { status: 'final', cancelled: true };
  }
  if (s.type.state === 'post') return { status: 'final', cancelled: false };
  if (s.type.state === 'in') return { status: 'in', cancelled: false };
  return { status: 'pre', cancelled: false };
}

/** ESPN numbers odds as "+154", "-212", "EVEN" or numbers. */
export function parseAmerican(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  if (/^even$/i.test(v.trim())) return 100;
  const n = Number(v.replace(/^\+/, ''));
  return Number.isFinite(n) && Math.abs(n) >= 100 ? n : null;
}

function pregameLines(odds: EspnOdds[] | undefined): PregameLines | null {
  const o = odds?.[0];
  if (!o) return null;
  const ml = (side: 'home' | 'away' | 'draw') =>
    parseAmerican(o.moneyline?.[side]?.close?.odds) ??
    parseAmerican(o.moneyline?.[side]?.open?.odds) ??
    parseAmerican(
      side === 'home'
        ? o.homeTeamOdds?.moneyLine
        : side === 'away'
          ? o.awayTeamOdds?.moneyLine
          : o.drawOdds?.moneyLine
    );
  const lines: PregameLines = {
    source: `espn:${o.provider?.name ?? 'unknown'}`,
    homeMoneyline: ml('home'),
    awayMoneyline: ml('away'),
    drawMoneyline: ml('draw'),
    spreadHome: typeof o.spread === 'number' ? o.spread : null,
    total: typeof o.overUnder === 'number' ? o.overUnder : null,
  };
  const any =
    lines.homeMoneyline ??
    lines.awayMoneyline ??
    lines.spreadHome ??
    lines.total;
  return any == null ? null : lines;
}

/** Home/away competitors; MMA has no home/away, so fight order 1 = home. */
function sides(sport: Sport, c: EspnCompetition) {
  if (sport === 'mma') {
    const sorted = [...c.competitors].sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0)
    );
    return { home: sorted[0], away: sorted[1] };
  }
  return {
    home: c.competitors.find((x) => x.homeAway === 'home'),
    away: c.competitors.find((x) => x.homeAway === 'away'),
  };
}

function competitor(x: EspnCompetitor): Competitor {
  return {
    name: x.team?.displayName ?? x.athlete?.displayName ?? 'Unknown',
    abbr: x.team?.abbreviation ?? null,
    score: Number(x.score ?? 0) || 0,
  };
}

function aliases(x: EspnCompetitor): string[] {
  const t = x.team;
  if (t) {
    return [
      t.displayName,
      t.shortDisplayName,
      t.location,
      t.abbreviation,
      t.name,
    ].filter((v): v is string => !!v);
  }
  return [x.athlete?.displayName, x.athlete?.shortName].filter(
    (v): v is string => !!v
  );
}

const FOOTBALL_PERIOD_SECONDS = 900;

function footballSituation(
  c: EspnCompetition,
  home: EspnCompetitor,
  away: EspnCompetitor
): Situation | null {
  const s = c.situation;
  if (!s) return null;
  const possession: Side | null =
    s.possession == null
      ? null
      : s.possession === home.team?.id
        ? 'home'
        : s.possession === away.team?.id
          ? 'away'
          : null;
  // ESPN's yardLine is measured from the HOME team's goal line (verified on
  // ten live games: UConn at SYR 42 -> 58, UCF at UCF 29 -> 71). possessionText
  // ("BUF 28") can use a different abbreviation than the team record ("BUFF"),
  // so it is only a fallback, and only when its abbreviation matches a team.
  let yardsToGoal: number | null = null;
  if (typeof s.yardLine === 'number' && possession) {
    yardsToGoal = possession === 'home' ? 100 - s.yardLine : s.yardLine;
  } else if (possession) {
    const m = s.possessionText?.match(/^(\S+)\s+(\d{1,2})$/);
    const own = (possession === 'home' ? home : away).team?.abbreviation;
    const opp = (possession === 'home' ? away : home).team?.abbreviation;
    if (m && (m[1] === own || m[1] === opp)) {
      yardsToGoal = m[1] === own ? 100 - Number(m[2]) : Number(m[2]);
    }
  }
  if (yardsToGoal != null && (yardsToGoal < 1 || yardsToGoal > 99)) {
    yardsToGoal = null;
  }
  return {
    kind: 'football',
    possession,
    down: s.down != null && s.down >= 1 && s.down <= 4 ? s.down : null,
    distance: s.distance != null && s.distance > 0 ? s.distance : null,
    yardsToGoal,
    text: s.downDistanceText ?? null,
  };
}

function baseballSituation(
  c: EspnCompetition,
  st: EspnStatus,
  regularSeason: boolean
): Situation | null {
  const detail = st.type.shortDetail ?? st.type.detail ?? '';
  const m = detail.match(/^(Top|Bot|Bottom|Mid|Middle|End)\s+(\d+)/i);
  if (!m) return null;
  const word = m[1]!.toLowerCase();
  let inning = Number(m[2]);
  let half: 'top' | 'bottom' = word === 'top' ? 'top' : 'bottom';
  let live = word === 'top' || word.startsWith('bot');
  if (word === 'end') {
    inning += 1;
    half = 'top';
  }
  const s = c.situation ?? {};
  const outs = s.outs ?? 0;
  if (live && outs >= 3) {
    // Third out recorded but status not yet flipped to Mid/End.
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
    first: live && !!s.onFirst,
    second: live && !!s.onSecond,
    third: live && !!s.onThird,
    scheduledInnings: 9,
    extraInningRunner: regularSeason,
  };
}

function baseballFraction(sit: Situation | null): number {
  if (sit?.kind !== 'baseball') return 1;
  const done =
    (sit.inning - 1) * 2 + (sit.half === 'bottom' ? 1 : 0) + sit.outs / 3;
  return Math.max(0, 1 - done / (sit.scheduledInnings * 2));
}

/** Parse every competition on a scoreboard into normalized states. */
export function parseScoreboard(
  sport: Sport,
  board: EspnScoreboard,
  fetchedAt = new Date().toISOString()
): GameState[] {
  const out: GameState[] = [];
  for (const ev of board.events ?? []) {
    for (const c of ev.competitions) {
      const { home, away } = sides(sport, c);
      if (!home || !away) continue;
      const st = c.status ?? ev.status;
      const { status, cancelled } = gameStatus(st);
      const h = competitor(home);
      const a = competitor(away);

      let situation: Situation | null = null;
      let fractionRemaining = status === 'pre' ? 1 : status === 'final' ? 0 : 1;
      const period = st.period ?? null;
      const clock = st.clock ?? null;
      if (status === 'in') {
        if (sport === 'nfl' || sport === 'ncaaf') {
          situation = footballSituation(c, home, away);
          const p = period ?? 1;
          fractionRemaining =
            p > 4
              ? 0
              : Math.max(
                  0,
                  ((4 - p) * FOOTBALL_PERIOD_SECONDS + (clock ?? 0)) / 3600
                );
        } else if (sport === 'mlb') {
          situation = baseballSituation(c, st, ev.season?.type !== 3);
          fractionRemaining = baseballFraction(situation);
        } else if (sport === 'soccer') {
          const minute = Math.floor((clock ?? 0) / 60);
          situation = { kind: 'soccer', minute, period: period ?? 1 };
          fractionRemaining = Math.max(0, (90 - minute) / 90);
        }
      }

      let winner: GameState['winner'] = null;
      if (status === 'final' && !cancelled) {
        if (home.winner) winner = 'home';
        else if (away.winner) winner = 'away';
        else if (sport !== 'mma') {
          winner =
            h.score > a.score ? 'home' : a.score > h.score ? 'away' : 'draw';
        } else winner = 'draw';
      }

      const prob = c.situation?.lastPlay?.probability;
      out.push({
        eventId: eventId(sport, c.id),
        sport,
        status,
        cancelled,
        startTime: new Date(c.startDate ?? c.date ?? ev.date).toISOString(),
        home: h,
        away: a,
        period,
        clockSeconds: clock,
        detail: st.type.shortDetail ?? st.type.detail ?? '',
        fractionRemaining,
        situation,
        winner,
        providerWinProb:
          status === 'in' && prob?.homeWinPercentage != null
            ? {
                home: prob.homeWinPercentage,
                away: prob.awayWinPercentage ?? 1 - prob.homeWinPercentage,
                ...(prob.tiePercentage ? { tie: prob.tiePercentage } : {}),
              }
            : null,
        fetchedAt,
      });
    }
  }
  return out;
}

/** List a scoreboard's competitions as matchable events. */
export function parseEvents(
  sport: Sport,
  league: string,
  board: EspnScoreboard
): ProviderEvent[] {
  const out: ProviderEvent[] = [];
  for (const ev of board.events ?? []) {
    for (const c of ev.competitions) {
      const { home, away } = sides(sport, c);
      if (!home || !away) continue;
      const h = competitor(home);
      const a = competitor(away);
      out.push({
        id: eventId(sport, c.id),
        sport,
        provider: 'espn',
        providerEventId: c.id,
        league,
        startTime: new Date(c.startDate ?? c.date ?? ev.date).toISOString(),
        home: { name: h.name, abbr: h.abbr, aliases: aliases(home) },
        away: { name: a.name, abbr: a.abbr, aliases: aliases(away) },
        status: gameStatus(c.status ?? ev.status).status,
        pregameLines: pregameLines(c.odds),
      });
    }
  }
  return out;
}

export class EspnProvider implements GameStateProvider {
  readonly name = 'espn';
  readonly sports = ['nfl', 'ncaaf', 'mlb', 'soccer', 'mma'] as const;

  constructor(
    private readonly fetcher: Fetcher = fetchJson,
    private readonly soccerLeagues: string[] = DEFAULT_SOCCER_LEAGUES
  ) {}

  /**
   * DraftKings lines from a game's summary. The summary keeps the closing
   * line after kickoff (the scoreboard drops odds once a game starts).
   */
  async fetchLines(
    sport: Sport,
    league: string | null,
    competitionId: string
  ): Promise<PregameLines | null> {
    const path =
      sport === 'soccer'
        ? `soccer/${league ?? this.soccerLeagues[0]}`
        : PATHS[sport].path;
    const summary = (await this.fetcher(
      `${BASE}/${path}/summary?event=${competitionId}`
    )) as {
      pickcenter?: EspnOdds[];
    };
    return pregameLines(summary.pickcenter);
  }

  private url(sport: Sport, league: string, date: string): string {
    if (sport === 'soccer') {
      return `${BASE}/soccer/${league}/scoreboard?dates=${compactDate(date)}`;
    }
    const p = PATHS[sport];
    return `${BASE}/${p.path}/scoreboard?dates=${compactDate(date)}${p.query}`;
  }

  private leagues(sport: Sport): string[] {
    return sport === 'soccer' ? this.soccerLeagues : [PATHS[sport].league];
  }

  async listEvents(sport: Sport, date: string): Promise<ProviderEvent[]> {
    // ESPN buckets scoreboards by US Eastern date; a late local game can sit
    // on the next day's board, so read both and filter by local date.
    const found = new Map<string, ProviderEvent>();
    for (const league of this.leagues(sport)) {
      for (const d of [date, addDays(date, 1)]) {
        const board = (await this.fetcher(
          this.url(sport, league, d)
        )) as EspnScoreboard;
        for (const ev of parseEvents(sport, league, board)) {
          if (localDate(ev.startTime) === date) found.set(ev.id, ev);
        }
      }
    }
    return [...found.values()];
  }

  async getStates(refs: EventRef[]): Promise<Map<string, GameState>> {
    // One scoreboard request per (sport, league, Eastern date).
    const groups = new Map<
      string,
      { sport: Sport; league: string; date: string }
    >();
    for (const r of refs) {
      const league = r.league ?? this.leagues(r.sport)[0]!;
      const date = localDate(r.startTime, 'America/New_York');
      groups.set(`${r.sport}|${league}|${date}`, {
        sport: r.sport,
        league,
        date,
      });
    }
    const wanted = new Set(refs.map((r) => r.id));
    const states = new Map<string, GameState>();
    for (const g of groups.values()) {
      const board = (await this.fetcher(
        this.url(g.sport, g.league, g.date)
      )) as EspnScoreboard;
      for (const s of parseScoreboard(g.sport, board)) {
        if (wanted.has(s.eventId)) states.set(s.eventId, s);
      }
    }
    return states;
  }
}
