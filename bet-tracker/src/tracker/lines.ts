import { and, asc, desc, eq, gt, lte } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { eventLines } from '../db/schema.js';

// History of the market lines fetched for each event, so a bet's placement
// value can use the lines as they stood when it was placed.

export type LinesSource = 'espn' | 'snapshot';

/** Record a fetch; skipped when unchanged from the latest of that source. */
export function recordLines(
  db: DbOrTx,
  eventId: string,
  source: LinesSource,
  lines: unknown,
  at: string
): void {
  const json = JSON.stringify(lines);
  const last = db
    .select({ json: eventLines.linesJson })
    .from(eventLines)
    .where(and(eq(eventLines.eventId, eventId), eq(eventLines.source, source)))
    .orderBy(desc(eventLines.fetchedAt), desc(eventLines.id))
    .limit(1)
    .get();
  if (last?.json === json) return;
  db.insert(eventLines)
    .values({ eventId, source, fetchedAt: at, linesJson: json })
    .run();
}

/**
 * The lines in effect at `at`: the latest fetched at or before it, else the
 * earliest fetched after it (a bet logged before any line was seen).
 */
export function linesAsOf<T>(
  db: DbOrTx,
  eventId: string,
  source: LinesSource,
  at: string
): T | null {
  const scope = and(
    eq(eventLines.eventId, eventId),
    eq(eventLines.source, source)
  );
  const before = db
    .select({ json: eventLines.linesJson })
    .from(eventLines)
    .where(and(scope, lte(eventLines.fetchedAt, at)))
    .orderBy(desc(eventLines.fetchedAt), desc(eventLines.id))
    .limit(1)
    .get();
  const row =
    before ??
    db
      .select({ json: eventLines.linesJson })
      .from(eventLines)
      .where(and(scope, gt(eventLines.fetchedAt, at)))
      .orderBy(asc(eventLines.fetchedAt), asc(eventLines.id))
      .limit(1)
      .get();
  return row ? (JSON.parse(row.json) as T) : null;
}
