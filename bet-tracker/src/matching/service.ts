import { and, eq, inArray, ne } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client.js';
import { events, legs, type LegRow } from '../db/schema.js';
import type { Side, Sport } from '../domain/types.js';
import type { Providers } from '../gamestate/registry.js';
import type { ProviderEvent } from '../gamestate/types.js';
import { recordLines } from '../tracker/lines.js';
import { matchEvent, type Candidate } from './match.js';

/** What we store/return per candidate so a later confirm needs no refetch. */
export interface StoredCandidate {
  eventId: string;
  label: string;
  startTime: string;
  score: number;
  sides: [Side, Side];
  event: ProviderEvent;
}

export interface LegMatchOutcome {
  legId: number;
  betId: number;
  eventLabel: string;
  status: LegRow['matchStatus'];
  eventId: string | null;
  side: Side | null;
  candidates: Omit<StoredCandidate, 'event'>[];
}

const eventLabel = (e: ProviderEvent) =>
  e.sport === 'mma'
    ? `${e.home.name} v ${e.away.name}`
    : `${e.away.name} @ ${e.home.name}`;

/** Insert or refresh an event row from a provider listing. */
export function upsertEvent(db: DbOrTx, e: ProviderEvent): void {
  const now = new Date().toISOString();
  const lines =
    e.status === 'pre' && e.pregameLines
      ? {
          providerLinesJson: JSON.stringify(e.pregameLines),
          providerLinesAt: now,
        }
      : {};
  db.insert(events)
    .values({
      id: e.id,
      sport: e.sport,
      provider: e.provider,
      providerEventId: e.providerEventId,
      league: e.league,
      startTime: e.startTime,
      homeName: e.home.name,
      awayName: e.away.name,
      homeAbbr: e.home.abbr,
      awayAbbr: e.away.abbr,
      status: e.status,
      ...lines,
    })
    .onConflictDoUpdate({
      target: events.id,
      set: {
        league: e.league,
        startTime: e.startTime,
        homeName: e.home.name,
        awayName: e.away.name,
        homeAbbr: e.home.abbr,
        awayAbbr: e.away.abbr,
        ...lines,
        updatedAt: now,
      },
    })
    .run();
  if (e.status === 'pre' && e.pregameLines) {
    recordLines(db, e.id, 'espn', e.pregameLines, now);
  }
}

/** Home/away of the backed team, given which side each participant matched. */
function selectionSide(leg: LegRow, sides: [Side, Side]): Side | null {
  if (leg.selectionKind !== 'team' || !leg.selectionTeam) return null;
  if (leg.selectionTeam === leg.participantA) return sides[0];
  if (leg.selectionTeam === leg.participantB) return sides[1];
  return null;
}

function toStored(c: Candidate): StoredCandidate {
  return {
    eventId: c.event.id,
    label: eventLabel(c.event),
    startTime: c.event.startTime,
    score: Math.round(c.score * 100) / 100,
    sides: c.sides,
    event: c.event,
  };
}

function outcome(leg: LegRow, stored: StoredCandidate[] = []): LegMatchOutcome {
  return {
    legId: leg.id,
    betId: leg.betId,
    eventLabel: leg.eventLabel,
    status: leg.matchStatus,
    eventId: leg.eventId,
    side: leg.side,
    candidates: stored.map(({ event: _e, ...rest }) => rest),
  };
}

function applyMatch(db: DbOrTx, leg: LegRow, c: StoredCandidate): LegRow {
  upsertEvent(db, c.event);
  return db
    .update(legs)
    .set({
      eventId: c.eventId,
      side: selectionSide(leg, c.sides),
      matchStatus: 'matched',
      matchCandidatesJson: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(legs.id, leg.id))
    .returning()
    .get();
}

/**
 * Match unmatched legs (optionally only `legIds`) to provider events. Exactly
 * one confident match is applied; otherwise candidates are stored on the leg
 * and returned for confirmation.
 */
export async function matchLegs(
  db: Db,
  providers: Providers,
  legIds?: number[]
): Promise<LegMatchOutcome[]> {
  const pending = db
    .select()
    .from(legs)
    .where(
      and(
        ne(legs.matchStatus, 'matched'),
        legIds ? inArray(legs.id, legIds) : undefined
      )
    )
    .all();

  // One listing per sport/date for the whole batch.
  const listings = new Map<string, Promise<ProviderEvent[]>>();
  const list = (sport: Sport, date: string) => {
    const key = `${sport}|${date}`;
    if (!listings.has(key)) {
      listings.set(key, providers.forSport(sport).listEvents(sport, date));
    }
    return listings.get(key)!;
  };

  const results: LegMatchOutcome[] = [];
  for (const leg of pending) {
    const listed = await list(leg.sport, leg.eventDate);
    const r = matchEvent([leg.participantA, leg.participantB], listed);
    if (r.status === 'matched') {
      results.push(outcome(applyMatch(db, leg, toStored(r.candidate))));
      continue;
    }
    const stored = r.candidates.map(toStored);
    const updated = db
      .update(legs)
      .set({
        matchStatus:
          r.status === 'needs_confirmation'
            ? 'needs_confirmation'
            : 'unmatched',
        matchCandidatesJson: stored.length ? JSON.stringify(stored) : null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(legs.id, leg.id))
      .returning()
      .get();
    results.push(outcome(updated, stored));
  }
  return results;
}

/** Confirm one of a leg's stored candidates. */
export function confirmLegMatch(
  db: Db,
  legId: number,
  eventId: string
): LegMatchOutcome {
  const leg = db.select().from(legs).where(eq(legs.id, legId)).get();
  if (!leg) throw new Error(`Leg ${legId} not found`);
  const stored: StoredCandidate[] = leg.matchCandidatesJson
    ? JSON.parse(leg.matchCandidatesJson)
    : [];
  const c = stored.find((s) => s.eventId === eventId);
  if (!c) {
    throw new Error(
      `Event ${eventId} is not a candidate for leg ${legId}; candidates: ${
        stored.map((s) => s.eventId).join(', ') || 'none'
      }`
    );
  }
  return db.transaction((tx) => outcome(applyMatch(tx, leg, c)));
}
