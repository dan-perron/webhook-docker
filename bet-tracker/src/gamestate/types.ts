import type { GameStatus, Side, Sport } from '../domain/types.js';

// Normalized live game state. Every provider maps into these shapes so models
// and the UI never see provider JSON.

export interface Competitor {
  name: string;
  abbr: string | null;
  score: number;
}

export interface FootballSituation {
  kind: 'football';
  possession: Side | null;
  down: number | null;
  distance: number | null;
  /** Yards from the possessing team to the opponent's goal line (1..99). */
  yardsToGoal: number | null;
  /** Provider text, e.g. "4th & 6 at UCF 29". */
  text: string | null;
}

/**
 * The half-inning being played, or the next one to be played during a break
 * (a "Middle 8th" is normalized to bottom 8th, 0 outs, bases empty).
 */
export interface BaseballSituation {
  kind: 'baseball';
  inning: number;
  half: 'top' | 'bottom';
  outs: number;
  first: boolean;
  second: boolean;
  third: boolean;
  scheduledInnings: number;
  /** Extra innings start with a runner on 2nd (regular season only). */
  extraInningRunner: boolean;
}

export interface SoccerSituation {
  kind: 'soccer';
  /** Match minute (elapsed), e.g. 67. */
  minute: number;
  period: number;
}

/** NHL: clock within the period. Period 4 = overtime, 5 = shootout. */
export interface HockeySituation {
  kind: 'hockey';
  period: number;
  /** Seconds left in the period. */
  clock: number;
  /** Playoff overtime is sudden-death 5v5 with no shootout. */
  postseason: boolean;
}

/**
 * Clock within the period: NBA/WNBA quarters (5+ = overtime), men's college
 * halves (3+ = overtime).
 */
export interface BasketballSituation {
  kind: 'basketball';
  period: number;
  clock: number;
}

/**
 * Volleyball (best of five): points in each set so far, the last being the
 * set in play. The game's score is sets won.
 */
export interface VolleyballSituation {
  kind: 'volleyball';
  set: number;
  sets: { home: number; away: number }[];
}

export type Situation =
  | FootballSituation
  | BaseballSituation
  | SoccerSituation
  | HockeySituation
  | BasketballSituation
  | VolleyballSituation;

export interface Broadcast {
  name: string;
  scope: 'national' | 'regional' | 'unknown';
}

export interface WatchInfo {
  location: string;
  ota: 'yes' | 'no' | 'unknown';
  channels: string[];
  streams: string[];
  note: string;
  source: string;
  checkedAt: string;
}

export interface GameState {
  eventId: string;
  sport: Sport;
  status: GameStatus;
  /** Postponed/cancelled/no contest: legs on it are void. */
  cancelled: boolean;
  startTime: string;
  home: Competitor;
  away: Competitor;
  period: number | null;
  /** Seconds left in the period (football) or elapsed (soccer). */
  clockSeconds: number | null;
  /** Human status line, e.g. "1:08 - 4th", "Top 8th", "Final". */
  detail: string;
  /** Share of regulation still to play: 1 before start, 0 when final. */
  fractionRemaining: number;
  situation: Situation | null;
  /** Postseason game (NHL overtime rules differ). */
  postseason?: boolean;
  /** Set once final (and not cancelled). */
  winner: Side | 'draw' | null;
  /** When the game actually ended, if the provider publishes it (MLB). */
  endTime?: string | null;
  /**
   * The provider's own win probability, if it publishes one. Shown for
   * reference and calibration comparison only; never fed to our models.
   */
  providerWinProb: { home: number; away: number; tie?: number } | null;
  /** US TV/stream listings; these do not imply local availability. */
  broadcasts?: Broadcast[];
  watch?: WatchInfo;
  fetchedAt: string;
}

/** Pregame lines a provider publishes for free (e.g. ESPN's DraftKings feed). */
export interface PregameLines {
  source: string;
  homeMoneyline: number | null;
  awayMoneyline: number | null;
  drawMoneyline: number | null;
  /** Home team's spread (negative = home favored). */
  spreadHome: number | null;
  spreadHomePrice?: number | null;
  spreadAwayPrice?: number | null;
  total: number | null;
  overPrice?: number | null;
  underPrice?: number | null;
}

/** An event as listed by a provider, for matching legs and polling. */
export interface ProviderEvent {
  id: string;
  sport: Sport;
  provider: string;
  providerEventId: string;
  league: string | null;
  startTime: string;
  home: { name: string; abbr: string | null; aliases: string[] };
  away: { name: string; abbr: string | null; aliases: string[] };
  status: GameStatus;
  pregameLines: PregameLines | null;
}

/** What a provider needs to fetch state for an already-matched event. */
export interface EventRef {
  id: string;
  sport: Sport;
  league: string | null;
  startTime: string;
}

export interface GameStateProvider {
  readonly name: string;
  readonly sports: readonly Sport[];
  /** Events on a local (America/Chicago) calendar date. */
  listEvents(sport: Sport, localDate: string): Promise<ProviderEvent[]>;
  /** Current state for the given events, keyed by event id. */
  getStates(refs: EventRef[]): Promise<Map<string, GameState>>;
  /**
   * Every team in a sport, named as its events name them. Resolves a team
   * with no game on the schedule yet (offseason). Empty where unsupported.
   */
  listTeams?(sport: Sport): Promise<TeamListing[]>;
}

export interface TeamListing {
  name: string;
  aliases: string[];
}

/** Injected for tests; production uses fetchJson. */
export type Fetcher = (url: string) => Promise<unknown>;

/** One player's box score line (only the stats props use). */
export interface PlayerStatLine {
  name: string;
  /** Provider athlete id (joins MLB plays to batters). */
  id?: string;
  /** The team's full name, as events name it. */
  team: string;
  /**
   * ESPN stat keys, e.g. rushingTouchdowns, receivingYards; MLB pitching
   * stats are prefixed (pitchingStrikeouts, pitchingOuts) to keep them apart
   * from batting's.
   */
  stats: Partial<Record<PlayerStatKey, number>>;
  /** In the game now (NBA: on the floor; MLB: still in the lineup). */
  active?: boolean;
  /** MLB: still the pitcher (false once pulled). */
  pitchingActive?: boolean;
  /** NBA: listed but hasn't played. */
  didNotPlay?: boolean;
  ejected?: boolean;
  /** MLB lineup spot 1-9 (a substitute takes his predecessor's). */
  batOrder?: number;
}

export const PLAYER_STAT_KEYS = [
  'passingYards',
  'passingTouchdowns',
  'rushingAttempts',
  'rushingYards',
  'rushingTouchdowns',
  'receptions',
  'receivingYards',
  'receivingTouchdowns',
  'interceptionTouchdowns',
  'kickReturnTouchdowns',
  'puntReturnTouchdowns',
  'defensiveTouchdowns',
  // NBA
  'minutes',
  'points',
  'rebounds',
  'assists',
  'threePointFieldGoalsMade',
  // MLB batting (doubles/triples from the plays; total bases derived)
  'atBats',
  'plateAppearances',
  'hits',
  'doubles',
  'triples',
  'homeRuns',
  'walks',
  'totalBases',
  // MLB pitching
  'pitchingStrikeouts',
  'pitchingOuts',
  'pitches',
] as const;
export type PlayerStatKey = (typeof PLAYER_STAT_KEYS)[number];

/** A touchdown from the game's scoring plays, credited to its scorer. */
export interface TouchdownPlay {
  /** Provider type, e.g. "Rushing Touchdown", "Passing Touchdown". */
  type: string;
  text: string;
  /** Who scored (the receiver on a passing TD), parsed from the text. */
  scorer: string | null;
  team: string | null;
  period: number | null;
  clock: string | null;
}

/** A game's player box score and touchdowns (for player props). */
export interface PlayerStats {
  /** The provider marked the game complete when this was fetched. */
  final: boolean;
  players: PlayerStatLine[];
  touchdowns: TouchdownPlay[];
  fetchedAt: string;
}

/** One game of a playoff series (ESPN team schedule). */
export interface SeriesGame {
  /** ESPN competition id. */
  id: string;
  /** Game number in the series (from ESPN's "Game 5 If Necessary" note). */
  number: number;
  startTime: string;
  /** ESPN team id of this game's host. */
  homeTeamId: string;
  status: GameStatus;
  cancelled: boolean;
  /** Set once final. */
  winnerTeamId: string | null;
  homeScore: number | null;
  awayScore: number | null;
  ifNecessary: boolean;
  detail: string;
  /** Game in progress: ESPN's live P(host wins). */
  liveHomeWinProb?: number | null;
}

/**
 * A playoff series now. home = the team with home field (game 1's host);
 * wins count final games.
 */
export interface SeriesState {
  seriesId: string;
  sport: Sport;
  title: string | null;
  bestOf: number;
  home: { id: string; name: string; abbr: string | null; wins: number };
  away: { id: string; name: string; abbr: string | null; wins: number };
  games: SeriesGame[];
  status: GameStatus;
  winner: Side | null;
  /** When the deciding game started (it ends GAME_MINUTES later). */
  decidedAt: string | null;
  fetchedAt: string;
}
