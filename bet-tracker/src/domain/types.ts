// Shared domain vocabulary. Money is integer cents in storage and dollars at
// the edges (MCP/web); prices are American odds integers (e.g. +128, -210).

/** Sports bets can be placed on: each has a win-probability model. */
export const BET_SPORTS = [
  'nfl',
  'ncaaf',
  'mlb',
  'nhl',
  'wnba',
  'nba',
  'ncaab',
  'soccer',
  'mma',
] as const;
export type BetSport = (typeof BET_SPORTS)[number];

/**
 * Followed on the Scores view only (no model, no bets): men's and women's
 * college hockey, women's college volleyball.
 */
export const SCORE_ONLY_SPORTS = ['ncaamh', 'ncaawh', 'ncaawvb'] as const;

export const SPORTS = [...BET_SPORTS, ...SCORE_ONLY_SPORTS] as const;
export type Sport = (typeof SPORTS)[number];

export const MARKETS = [
  'moneyline',
  'moneyline3way',
  'spread',
  'total',
  'player_prop',
  'series_winner',
  'series_spread',
] as const;
export type Market = (typeof MARKETS)[number];

/**
 * Series markets: on a playoff series (legs link to a `series`, not an
 * event). series_winner backs a team to win it; series_spread backs a team
 * on games won minus games lost (e.g. Brewers -2.5 = win it 4-0 or 4-1).
 */
export const SERIES_MARKETS = ['series_winner', 'series_spread'] as const;
export const isSeriesMarket = (m: Market) =>
  m === 'series_winner' || m === 'series_spread';

/** Game markets: priced by the game-state models (not props or series). */
export const isGameMarket = (m: Market) =>
  m !== 'player_prop' && !isSeriesMarket(m);

/**
 * Player prop types (market player_prop). Each has a spec in
 * `src/models/props.ts` (sport, selections, line, stat counted).
 */
export const PROP_TYPES = [
  'anytime_td',
  // NBA
  'points',
  'rebounds',
  'assists',
  'threes',
  'pra',
  // MLB batters
  'home_runs',
  'total_bases',
  'hits',
  // MLB pitchers
  'pitcher_strikeouts',
  'pitcher_outs',
] as const;
export type PropType = (typeof PROP_TYPES)[number];

/** Sports with player props (the box score provider must cover them). */
export const PROP_SPORTS = ['nfl', 'nba', 'mlb'] as const;
/** Sports with series markets (ESPN lists their playoff series). */
export const SERIES_SPORTS = ['mlb', 'nba', 'nhl', 'wnba'] as const;

/**
 * Where a bet came from: Claude recommended it as +EV, or Dan's own one-off.
 * Null = not tagged (bets from before origins existed).
 */
export const BET_ORIGINS = ['recommended', 'own'] as const;
export type BetOrigin = (typeof BET_ORIGINS)[number];
/** Filter value for bets with no origin. */
export const UNTAGGED = 'untagged' as const;
export const ORIGIN_FILTERS = [...BET_ORIGINS, UNTAGGED] as const;
export type OriginFilter = (typeof ORIGIN_FILTERS)[number];

/**
 * What a leg is backing. Team/fighter picks carry the name in `selectionTeam`
 * and get resolved to a home/away `side` once the leg is matched to an event.
 * Player props: yes (e.g. anytime TD) or over/under a line; `selectionTeam`
 * is the player's team and `side` its home/away.
 */
export const SELECTION_KINDS = [
  'team',
  'draw',
  'over',
  'under',
  'yes',
] as const;
export type SelectionKind = (typeof SELECTION_KINDS)[number];

export const SIDES = ['home', 'away'] as const;
export type Side = (typeof SIDES)[number];

export const BET_STATUSES = ['open', 'won', 'lost', 'push', 'void'] as const;
export type BetStatus = (typeof BET_STATUSES)[number];
export type LegStatus = BetStatus;

export const BET_TYPES = ['single', 'parlay'] as const;
export type BetType = (typeof BET_TYPES)[number];

export const BOOST_KINDS = [
  'profit_boost',
  'boost_builder',
  'live_boost',
] as const;
export type BoostKind = (typeof BOOST_KINDS)[number];

/** Where a leg's pregame prior came from, in order of preference. */
export const PRIOR_SOURCES = [
  'espn_lines',
  'pregame_snapshot',
  'entered_odds',
  'neutral',
  // Player props: the leg's own price, de-vigged with an assumed prop hold.
  'entered_price',
] as const;

/** Where a series' per-game strength came from, in order of preference. */
export const SERIES_PRIOR_SOURCES = [
  'espn_lines',
  'entered_odds',
  'neutral',
] as const;
export type SeriesPriorSource = (typeof SERIES_PRIOR_SOURCES)[number];
export type PriorSource = (typeof PRIOR_SOURCES)[number];

export const MATCH_STATUSES = [
  'unmatched',
  'needs_confirmation',
  'matched',
] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export const GAME_STATUSES = ['pre', 'in', 'final'] as const;
export type GameStatus = (typeof GAME_STATUSES)[number];
