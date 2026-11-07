import { and, asc, count, eq, inArray, isNull } from 'drizzle-orm';
import {
  betInputSchema,
  legInputSchema,
  type BetInput,
} from '../domain/betInput.js';
import {
  UNTAGGED,
  type BetOrigin,
  type BetStatus,
  type OriginFilter,
} from '../domain/types.js';
import { betStatus } from '../domain/value.js';
import type { DbOrTx } from './client.js';
import {
  bets,
  legs,
  predictionSnapshots,
  type BetRow,
  type LegRow,
} from './schema.js';

export interface BetWithLegs {
  bet: BetRow;
  legs: LegRow[];
}

export const toCents = (dollars: number) => Math.round(dollars * 100);

/** Validate structured input and insert a bet with its legs (unmatched). */
export function createBet(db: DbOrTx, input: BetInput): BetWithLegs {
  const parsed = betInputSchema.parse(input);
  return db.transaction((tx) => {
    const bet = tx
      .insert(bets)
      .values({
        book: parsed.book,
        externalBetId: parsed.externalBetId ?? null,
        placedAt: parsed.placedAt
          ? new Date(parsed.placedAt).toISOString()
          : null,
        placedLive: parsed.placedLive,
        stakeCents: toCents(parsed.stake),
        betType: parsed.legs.length > 1 ? 'parlay' : 'single',
        priceAmerican: parsed.price,
        boostPct: parsed.boostPct ?? null,
        boostKind: parsed.boostKind ?? null,
        boostedPriceAmerican: parsed.boostedPrice ?? null,
        statedPayoutCents:
          parsed.statedPayout != null ? toCents(parsed.statedPayout) : null,
        tokenInfo: parsed.tokenInfo ?? null,
        notes: parsed.notes ?? null,
        origin: parsed.origin ?? null,
        recommendedAt: parsed.recommendedAt
          ? new Date(parsed.recommendedAt).toISOString()
          : null,
      })
      .returning()
      .get();

    const legRows = parsed.legs.map((leg, i) =>
      tx
        .insert(legs)
        .values({
          betId: bet.id,
          legIndex: i,
          sport: leg.sport,
          eventDate: leg.eventDate,
          eventLabel:
            leg.eventLabel ?? `${leg.participants[0]} v ${leg.participants[1]}`,
          participantA: leg.participants[0],
          participantB: leg.participants[1],
          market: leg.market,
          propType: leg.prop?.type ?? null,
          playerName: leg.prop?.player ?? null,
          selectionKind: leg.selection.kind,
          // A prop's team is the player's (resolves home/away when matched).
          selectionTeam: leg.prop?.team ?? leg.selection.team ?? null,
          line: leg.line ?? null,
          priceAmerican: leg.price,
          recommendedPrice: leg.recommendedPrice ?? null,
        })
        .returning()
        .get()
    );
    return { bet, legs: legRows };
  });
}

export function getBet(db: DbOrTx, id: number): BetWithLegs | undefined {
  const bet = db.select().from(bets).where(eq(bets.id, id)).get();
  if (!bet) return undefined;
  const legRows = db
    .select()
    .from(legs)
    .where(eq(legs.betId, id))
    .orderBy(asc(legs.legIndex))
    .all();
  return { bet, legs: legRows };
}

/** Bets, optionally by status and origin ("untagged" = no origin). */
export function listBets(
  db: DbOrTx,
  status?: BetStatus,
  origin?: OriginFilter
): BetWithLegs[] {
  const betRows = db
    .select()
    .from(bets)
    .where(
      and(
        status ? eq(bets.status, status) : undefined,
        origin === UNTAGGED
          ? isNull(bets.origin)
          : origin
            ? eq(bets.origin, origin)
            : undefined
      )
    )
    .orderBy(asc(bets.id))
    .all();
  if (betRows.length === 0) return [];
  const legRows = db
    .select()
    .from(legs)
    .where(
      inArray(
        legs.betId,
        betRows.map((b) => b.id)
      )
    )
    .orderBy(asc(legs.betId), asc(legs.legIndex))
    .all();
  return betRows.map((bet) => ({
    bet,
    legs: legRows.filter((l) => l.betId === bet.id),
  }));
}

export function countBets(db: DbOrTx): number {
  return db.select({ n: count() }).from(bets).get()?.n ?? 0;
}

/** Bet-level fields editable after creation (dollars at this edge). */
export interface BetUpdate {
  book?: string;
  externalBetId?: string | null;
  placedAt?: string | null;
  placedLive?: boolean;
  stake?: number;
  price?: number;
  boostPct?: number | null;
  boostKind?: BetRow['boostKind'];
  boostedPrice?: number | null;
  statedPayout?: number | null;
  tokenInfo?: string | null;
  notes?: string | null;
  /** recommended | own; null = untagged. */
  origin?: BetOrigin | null;
  /** When Claude recommended it (any ISO offset; null clears). */
  recommendedAt?: string | null;
  /** Correct when a settled bet settled (any ISO offset; null clears). */
  settledAt?: string | null;
}

export function updateBet(
  db: DbOrTx,
  id: number,
  u: BetUpdate
): BetWithLegs | undefined {
  const set: Partial<typeof bets.$inferInsert> = {};
  if (u.book !== undefined) set.book = u.book;
  if (u.externalBetId !== undefined) set.externalBetId = u.externalBetId;
  if (u.placedAt !== undefined)
    set.placedAt = u.placedAt ? new Date(u.placedAt).toISOString() : null;
  if (u.placedLive !== undefined) set.placedLive = u.placedLive;
  if (u.stake !== undefined) set.stakeCents = toCents(u.stake);
  if (u.price !== undefined) set.priceAmerican = u.price;
  if (u.boostPct !== undefined) set.boostPct = u.boostPct;
  if (u.boostKind !== undefined) set.boostKind = u.boostKind;
  if (u.boostedPrice !== undefined) set.boostedPriceAmerican = u.boostedPrice;
  if (u.statedPayout !== undefined)
    set.statedPayoutCents =
      u.statedPayout == null ? null : toCents(u.statedPayout);
  if (u.tokenInfo !== undefined) set.tokenInfo = u.tokenInfo;
  if (u.notes !== undefined) set.notes = u.notes;
  if (u.origin !== undefined) set.origin = u.origin;
  if (u.recommendedAt !== undefined)
    set.recommendedAt = u.recommendedAt
      ? new Date(u.recommendedAt).toISOString()
      : null;
  if (u.settledAt !== undefined) {
    const bet = db.select().from(bets).where(eq(bets.id, id)).get();
    if (bet?.status === 'open' && u.settledAt)
      throw new Error(`Bet ${id} is open; settle it before setting settledAt`);
    set.settledAt = u.settledAt ? new Date(u.settledAt).toISOString() : null;
  }
  if (Object.keys(set).length === 0) return getBet(db, id);
  if (u.placedLive !== undefined) {
    // Placement probabilities depend on it (prior vs entered price): redo.
    // A live bet has no close, so its close is re-resolved too.
    db.update(legs)
      .set({ pWinPlacement: null, pPushPlacement: null, closeJson: null })
      .where(eq(legs.betId, id))
      .run();
  }
  const updated = db
    .update(bets)
    .set({ ...set, updatedAt: new Date().toISOString() })
    .where(eq(bets.id, id))
    .returning()
    .get();
  return updated ? getBet(db, id) : undefined;
}

/**
 * Record a result by hand (overrides what the legs say). A single bet's open
 * player prop leg takes the same result (props may have no box score to
 * settle from), so recomputes keep it.
 */
export function settleBet(
  db: DbOrTx,
  id: number,
  result: Exclude<BetStatus, 'open'> | 'open'
): BetWithLegs | undefined {
  const now = new Date().toISOString();
  return db.transaction((tx) => {
    const updated = tx
      .update(bets)
      .set({
        status: result,
        settledAt: result === 'open' ? null : now,
        updatedAt: now,
      })
      .where(eq(bets.id, id))
      .returning()
      .get();
    if (!updated) return undefined;
    if (updated.betType === 'single' && result !== 'open') {
      const prop = tx
        .select()
        .from(legs)
        .where(and(eq(legs.betId, id), eq(legs.market, 'player_prop')))
        .get();
      if (prop?.status === 'open') settleLegRow(tx, prop, result, now);
    }
    return getBet(tx, id);
  });
}

/** A leg settled by hand: certain outcome, calibration outcome stamped. */
function settleLegRow(
  tx: DbOrTx,
  leg: LegRow,
  result: Exclude<BetStatus, 'open'>,
  now: string
) {
  tx.update(legs)
    .set({
      status: result,
      pWin: result === 'won' ? 1 : 0,
      pPush: result === 'push' || result === 'void' ? 1 : 0,
      model: 'manual',
      evaluatedAt: now,
      updatedAt: now,
    })
    .where(eq(legs.id, leg.id))
    .run();
  tx.update(predictionSnapshots)
    .set({ outcome: result === 'won' ? 1 : result === 'lost' ? 0 : null })
    .where(eq(predictionSnapshots.legId, leg.id))
    .run();
}

/**
 * Settle one leg by hand (e.g. a player prop with no box score), then
 * re-derive the bet's status from its legs; "open" reopens the leg for the
 * tracker. Returns the bet.
 */
export function settleLeg(
  db: DbOrTx,
  legId: number,
  result: Exclude<BetStatus, 'open'> | 'open'
): BetWithLegs {
  const now = new Date().toISOString();
  return db.transaction((tx) => {
    const leg = tx.select().from(legs).where(eq(legs.id, legId)).get();
    if (!leg) throw new Error(`Leg ${legId} not found`);
    if (result === 'open') {
      tx.update(legs)
        .set({ status: 'open', model: null, evaluatedAt: null, updatedAt: now })
        .where(eq(legs.id, legId))
        .run();
    } else {
      settleLegRow(tx, leg, result, now);
    }
    const status = betStatus(
      tx
        .select({ status: legs.status })
        .from(legs)
        .where(eq(legs.betId, leg.betId))
        .all()
    );
    const bet = tx.select().from(bets).where(eq(bets.id, leg.betId)).get()!;
    if (status !== bet.status)
      tx.update(bets)
        .set({
          status,
          settledAt: status === 'open' ? null : now,
          updatedAt: now,
        })
        .where(eq(bets.id, bet.id))
        .run();
    return getBet(tx, leg.betId)!;
  });
}

/** Delete a bet with its legs and snapshots. Returns whether it existed. */
export function removeBet(db: DbOrTx, id: number): boolean {
  return (
    db.delete(bets).where(eq(bets.id, id)).returning({ id: bets.id }).all()
      .length > 0
  );
}

/** Editable leg fields (American odds; line from the selection's side). */
export interface LegUpdate {
  price?: number;
  line?: number | null;
  selection?: { kind: LegRow['selectionKind']; team?: string };
  /** The price when recommended (American); null clears. */
  recommendedPrice?: number | null;
}

/**
 * Edit a leg's price, line or selection, re-validated like a new leg. A
 * single bet's price follows its leg. Changing the selection or line drops
 * the leg's calibration snapshots (they predicted a different outcome).
 * Callers recompute the bet afterwards (Tracker.recomputeBet).
 */
export function updateLeg(db: DbOrTx, legId: number, u: LegUpdate): LegRow {
  const leg = db.select().from(legs).where(eq(legs.id, legId)).get();
  if (!leg) throw new Error(`Leg ${legId} not found`);
  const isProp = leg.market === 'player_prop';
  const selection = u.selection
    ? // A prop's selectionTeam is the player's team, not a pick.
      isProp
      ? { kind: u.selection.kind }
      : u.selection
    : {
        kind: leg.selectionKind,
        ...(leg.selectionTeam && !isProp ? { team: leg.selectionTeam } : {}),
      };
  const parsed = legInputSchema.parse({
    sport: leg.sport,
    eventDate: leg.eventDate,
    participants: [leg.participantA, leg.participantB],
    market: leg.market,
    ...(isProp
      ? {
          prop: {
            type: leg.propType,
            player: leg.playerName,
            team: leg.selectionTeam,
          },
        }
      : {}),
    selection,
    ...((u.line !== undefined ? u.line : leg.line) != null
      ? { line: u.line !== undefined ? u.line : leg.line }
      : {}),
    price: u.price ?? leg.priceAmerican,
    recommendedPrice:
      u.recommendedPrice !== undefined
        ? u.recommendedPrice
        : leg.recommendedPrice,
  });
  const newTeam = isProp ? leg.selectionTeam : (parsed.selection.team ?? null);
  const selectionChanged =
    parsed.selection.kind !== leg.selectionKind ||
    newTeam !== leg.selectionTeam;
  // Home/away of a new team pick: the other side when it switched teams;
  // re-match when the side was never known.
  let side = leg.side;
  let matchStatus = leg.matchStatus;
  if (isProp) side = leg.side;
  else if (parsed.selection.kind !== 'team') side = null;
  else if (newTeam !== leg.selectionTeam) {
    if (leg.side) side = leg.side === 'home' ? 'away' : 'home';
    else if (leg.eventId || leg.seriesId) matchStatus = 'unmatched';
  }
  const marketChanged =
    selectionChanged || parsed.line !== (leg.line ?? undefined);
  return db.transaction((tx) => {
    const updated = tx
      .update(legs)
      .set({
        priceAmerican: parsed.price,
        recommendedPrice: parsed.recommendedPrice ?? null,
        line: parsed.line ?? null,
        selectionKind: parsed.selection.kind,
        selectionTeam: newTeam,
        side,
        matchStatus,
        // A close priced a different market: re-resolve it (missed if started).
        ...(marketChanged ? { closeJson: null } : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(legs.id, legId))
      .returning()
      .get();
    if (marketChanged) {
      tx.delete(predictionSnapshots)
        .where(eq(predictionSnapshots.legId, legId))
        .run();
    }
    const bet = tx.select().from(bets).where(eq(bets.id, leg.betId)).get()!;
    if (bet.betType === 'single' && bet.priceAmerican !== parsed.price) {
      tx.update(bets)
        .set({ priceAmerican: parsed.price })
        .where(eq(bets.id, bet.id))
        .run();
    }
    return updated;
  });
}
