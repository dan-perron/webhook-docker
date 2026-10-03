import { asc, count, eq, inArray } from 'drizzle-orm';
import { betInputSchema, type BetInput } from '../domain/betInput.js';
import type { BetStatus } from '../domain/types.js';
import type { DbOrTx } from './client.js';
import { bets, legs, type BetRow, type LegRow } from './schema.js';

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
          selectionKind: leg.selection.kind,
          selectionTeam: leg.selection.team ?? null,
          line: leg.line ?? null,
          priceAmerican: leg.price,
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

export function listBets(db: DbOrTx, status?: BetStatus): BetWithLegs[] {
  const betRows = db
    .select()
    .from(bets)
    .where(status ? eq(bets.status, status) : undefined)
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
  if (Object.keys(set).length === 0) return getBet(db, id);
  if (u.placedLive !== undefined) {
    // Placement probabilities depend on it (prior vs entered price): redo.
    db.update(legs)
      .set({ pWinPlacement: null, pPushPlacement: null })
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

/** Record a result by hand (overrides what the legs say). */
export function settleBet(
  db: DbOrTx,
  id: number,
  result: Exclude<BetStatus, 'open'> | 'open'
): BetWithLegs | undefined {
  const now = new Date().toISOString();
  const updated = db
    .update(bets)
    .set({
      status: result,
      settledAt: result === 'open' ? null : now,
      updatedAt: now,
    })
    .where(eq(bets.id, id))
    .returning()
    .get();
  return updated ? getBet(db, id) : undefined;
}

/** Delete a bet with its legs and snapshots. Returns whether it existed. */
export function removeBet(db: DbOrTx, id: number): boolean {
  return (
    db.delete(bets).where(eq(bets.id, id)).returning({ id: bets.id }).all()
      .length > 0
  );
}
