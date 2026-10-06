// Shared domain vocabulary. Money is integer cents in storage and dollars at
// the edges (MCP/web); prices are American odds integers (e.g. +128, -210).

export const SPORTS = [
  'nfl',
  'ncaaf',
  'mlb',
  'nhl',
  'wnba',
  'soccer',
  'mma',
] as const;
export type Sport = (typeof SPORTS)[number];

export const MARKETS = [
  'moneyline',
  'moneyline3way',
  'spread',
  'total',
] as const;
export type Market = (typeof MARKETS)[number];

/**
 * What a leg is backing. Team/fighter picks carry the name in `selectionTeam`
 * and get resolved to a home/away `side` once the leg is matched to an event.
 */
export const SELECTION_KINDS = ['team', 'draw', 'over', 'under'] as const;
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
] as const;
export type PriorSource = (typeof PRIOR_SOURCES)[number];

export const MATCH_STATUSES = [
  'unmatched',
  'needs_confirmation',
  'matched',
] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export const GAME_STATUSES = ['pre', 'in', 'final'] as const;
export type GameStatus = (typeof GAME_STATUSES)[number];
