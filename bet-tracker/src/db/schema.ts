import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';
import {
  BET_STATUSES,
  BET_TYPES,
  BOOST_KINDS,
  GAME_STATUSES,
  MARKETS,
  MATCH_STATUSES,
  PRIOR_SOURCES,
  SELECTION_KINDS,
  SIDES,
  SPORTS,
} from '../domain/types.js';

const timestamps = {
  createdAt: text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
};

/**
 * A game/fight from a GameStateProvider. `id` is provider-qualified, e.g.
 * "espn:ncaaf:401752896" or "mlb:813024", so providers can be swapped/mixed.
 */
export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    sport: text('sport', { enum: SPORTS }).notNull(),
    provider: text('provider').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    // Provider-specific league key (e.g. ESPN "college-football", "uefa.worldq").
    league: text('league'),
    startTime: text('start_time').notNull(),
    homeName: text('home_name').notNull(),
    awayName: text('away_name').notNull(),
    homeAbbr: text('home_abbr'),
    awayAbbr: text('away_abbr'),
    status: text('status', { enum: GAME_STATUSES }).notNull().default('pre'),
    // Last normalized GameState (JSON) and when it was fetched.
    stateJson: text('state_json'),
    stateUpdatedAt: text('state_updated_at'),
    nextPollAt: text('next_poll_at'),
    // Free pregame lines the game-state provider publishes (e.g. ESPN's
    // DraftKings feed), refreshed while the event is still pre-game.
    providerLinesJson: text('provider_lines_json'),
    providerLinesAt: text('provider_lines_at'),
    // Optional one-time pregame odds snapshot (JSON) used as the prior.
    pregameOddsJson: text('pregame_odds_json'),
    pregameOddsAt: text('pregame_odds_at'),
    ...timestamps,
  },
  (t) => [index('events_status_idx').on(t.status)]
);

export const bets = sqliteTable('bets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  book: text('book').notNull(),
  externalBetId: text('external_bet_id'),
  placedAt: text('placed_at'),
  // Placed while the game was in progress; entered odds then reflect live
  // state, so they are not used as a pregame prior.
  placedLive: integer('placed_live', { mode: 'boolean' })
    .notNull()
    .default(false),
  stakeCents: integer('stake_cents').notNull(),
  betType: text('bet_type', { enum: BET_TYPES }).notNull(),
  priceAmerican: integer('price_american').notNull(),
  boostPct: real('boost_pct'),
  boostKind: text('boost_kind', { enum: BOOST_KINDS }),
  boostedPriceAmerican: integer('boosted_price_american'),
  // Total return (stake + profit) the book stated; preferred over price math.
  statedPayoutCents: integer('stated_payout_cents'),
  // Free text, e.g. "Touchdown Tally token used". Token payout is independent.
  tokenInfo: text('token_info'),
  notes: text('notes'),
  status: text('status', { enum: BET_STATUSES }).notNull().default('open'),
  settledAt: text('settled_at'),
  // Same-game groups priced from one game model: JSON
  // { [eventId]: { p, pushedLegIds }[] } (non-losing outcomes), now and at
  // placement (pregame bets only).
  jointJson: text('joint_json'),
  jointPlacementJson: text('joint_placement_json'),
  ...timestamps,
});

export const legs = sqliteTable(
  'legs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    betId: integer('bet_id')
      .notNull()
      .references(() => bets.id, { onDelete: 'cascade' }),
    legIndex: integer('leg_index').notNull(),
    sport: text('sport', { enum: SPORTS }).notNull(),
    // Local (America/Chicago) calendar date of the event, YYYY-MM-DD.
    eventDate: text('event_date').notNull(),
    eventLabel: text('event_label').notNull(),
    // The two participants as entered; order is not meaningful.
    participantA: text('participant_a').notNull(),
    participantB: text('participant_b').notNull(),
    eventId: text('event_id').references(() => events.id),
    matchStatus: text('match_status', { enum: MATCH_STATUSES })
      .notNull()
      .default('unmatched'),
    // JSON array of candidate events when matchStatus = needs_confirmation.
    matchCandidatesJson: text('match_candidates_json'),
    market: text('market', { enum: MARKETS }).notNull(),
    selectionKind: text('selection_kind', { enum: SELECTION_KINDS }).notNull(),
    selectionTeam: text('selection_team'),
    // Resolved home/away for team picks once matched.
    side: text('side', { enum: SIDES }),
    // Spread from the selection's perspective (+5.5 / -21.5) or total line.
    line: real('line'),
    priceAmerican: integer('price_american').notNull(),
    status: text('status', { enum: BET_STATUSES }).notNull().default('open'),
    priorSource: text('prior_source', { enum: PRIOR_SOURCES }),
    // JSON prior inputs (home win prob, spread, total, ...) used by models.
    priorJson: text('prior_json'),
    // Latest model evaluation (P(push) covers integer lines and voids).
    pWin: real('p_win'),
    pPush: real('p_push'),
    model: text('model'),
    modelInputsJson: text('model_inputs_json'),
    evaluatedAt: text('evaluated_at'),
    // Probabilities at placement: from the prior (pregame bets) or the
    // de-vigged entered price (live bets). Set once.
    pWinPlacement: real('p_win_placement'),
    pPushPlacement: real('p_push_placement'),
    // Log-odds shift matching the pregame model to the market's price for
    // this exact line (null = no market price); frozen at kickoff with the
    // prior. anchorSource names the price ('none' once checked and absent).
    anchorLogit: real('anchor_logit'),
    anchorSource: text('anchor_source'),
    ...timestamps,
  },
  (t) => [
    index('legs_bet_idx').on(t.betId),
    index('legs_event_idx').on(t.eventId),
  ]
);

/**
 * Model output log for calibration. legId null = whole-bet probability.
 * `outcome` is 1/0 once settled (null for open, push, or void).
 */
export const predictionSnapshots = sqliteTable(
  'prediction_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    betId: integer('bet_id')
      .notNull()
      .references(() => bets.id, { onDelete: 'cascade' }),
    legId: integer('leg_id').references(() => legs.id, {
      onDelete: 'cascade',
    }),
    sport: text('sport').notNull(),
    market: text('market').notNull(),
    takenAt: text('taken_at').notNull(),
    gameStatus: text('game_status', { enum: GAME_STATUSES }).notNull(),
    // Fraction of regulation remaining when the snapshot was taken (0..1).
    fractionRemaining: real('fraction_remaining'),
    probability: real('probability').notNull(),
    outcome: integer('outcome'),
  },
  (t) => [
    index('snapshots_bet_idx').on(t.betId),
    index('snapshots_leg_idx').on(t.legId),
  ]
);

/** Small key/value store (e.g. Odds API quota headers). */
export const meta = sqliteTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export type EventRow = typeof events.$inferSelect;
export type BetRow = typeof bets.$inferSelect;
export type NewBetRow = typeof bets.$inferInsert;
export type LegRow = typeof legs.$inferSelect;
export type NewLegRow = typeof legs.$inferInsert;
export type PredictionSnapshotRow = typeof predictionSnapshots.$inferSelect;

// --- OAuth (single user; for claude.ai / mobile MCP connectors) -------------

/** Dynamically registered public clients (PKCE, no secret). */
export const oauthClients = sqliteTable('oauth_clients', {
  clientId: text('client_id').primaryKey(),
  clientName: text('client_name'),
  redirectUrisJson: text('redirect_uris_json').notNull(),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

/** Authorization codes, stored hashed; single use, short-lived. */
export const oauthCodes = sqliteTable('oauth_codes', {
  codeHash: text('code_hash').primaryKey(),
  clientId: text('client_id')
    .notNull()
    .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  scope: text('scope'),
  expiresAt: text('expires_at').notNull(),
  usedAt: text('used_at'),
});

/** Access and refresh tokens, stored hashed. */
export const oauthTokens = sqliteTable(
  'oauth_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    kind: text('kind', { enum: ['access', 'refresh'] }).notNull(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    scope: text('scope'),
    expiresAt: text('expires_at').notNull(),
    revokedAt: text('revoked_at'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  },
  (t) => [index('oauth_tokens_client_idx').on(t.clientId)]
);
