import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import {
  eventLines,
  events,
  legs,
  watches,
  type EventRow,
} from '../db/schema.js';
import type { Side } from '../domain/types.js';
import type { GameState, Situation } from '../gamestate/types.js';
import { CONFIDENT, nameScore } from '../matching/match.js';

// An event's home/away orientation. ESPN can swap home and away on an event
// it already listed (neutral sites: UConn v Duke at T-Mobile Arena was "UConn
// @ Duke" in the morning and "Duke @ UConn" by tip-off). Everything we store
// by home/away (the event's names, its lines and line history, each leg's
// side, a watch's leader) is kept in the event row's orientation; the
// provider's scoreboard (listing and state) is the authority, and when it
// disagrees `reorientEvent` swaps all of it in one transaction. Lines also
// carry the home team they were fetched with (`homeName`), so a line from
// the other orientation is flipped instead of being read the wrong way round.

export interface Team {
  name: string;
  abbr?: string | null;
  aliases?: string[];
}

/** Lines stored by home/away; `homeName` tags the orientation they're in. */
export interface OrientedLines {
  homeMoneyline: number | null;
  awayMoneyline: number | null;
  spreadHome: number | null;
  spreadHomePrice?: number | null;
  spreadAwayPrice?: number | null;
  homeName?: string | null;
  awayName?: string | null;
}

const teamAliases = (t: Team) =>
  [t.name, t.abbr, ...(t.aliases ?? [])].filter((x): x is string => !!x);

/**
 * Which side a team is on, by name or abbreviation ("Duke", "Duke Blue
 * Devils", "DUKE" all hit Duke Blue Devils / DUKE). Null unless one side is
 * a confident match and the other is strictly worse.
 */
export function sideOfTeam(team: string, home: Team, away: Team): Side | null {
  const h = nameScore(team, teamAliases(home));
  const a = nameScore(team, teamAliases(away));
  if (Math.max(h, a) < CONFIDENT || h === a) return null;
  return h > a ? 'home' : 'away';
}

/**
 * The provider now lists the stored away team at home (and vice versa).
 * Exact names (the same provider spells them the same way), else abbrs.
 */
export function isSwapped(
  stored: Pick<EventRow, 'homeName' | 'awayName' | 'homeAbbr' | 'awayAbbr'>,
  home: Team,
  away: Team
): boolean {
  if (stored.homeName === stored.awayName) return false;
  if (home.name === stored.awayName && away.name === stored.homeName)
    return true;
  return (
    !!home.abbr &&
    !!away.abbr &&
    home.abbr !== away.abbr &&
    home.abbr === stored.awayAbbr &&
    away.abbr === stored.homeAbbr &&
    home.name !== stored.homeName
  );
}

/** The same lines from the other team's side. */
export function flipLines<T extends OrientedLines>(l: T): T {
  return {
    ...l,
    homeMoneyline: l.awayMoneyline,
    awayMoneyline: l.homeMoneyline,
    spreadHome: l.spreadHome == null ? null : -l.spreadHome,
    ...('spreadHomePrice' in l || 'spreadAwayPrice' in l
      ? {
          spreadHomePrice: l.spreadAwayPrice ?? null,
          spreadAwayPrice: l.spreadHomePrice ?? null,
        }
      : {}),
    ...('homeName' in l || 'awayName' in l
      ? { homeName: l.awayName ?? null, awayName: l.homeName ?? null }
      : {}),
  };
}

/**
 * Lines in the event's orientation: flipped when they are tagged with the
 * event's away team at home. Untagged lines are taken as they are.
 */
export function alignLines<T extends OrientedLines>(
  l: T,
  e: Pick<EventRow, 'homeName' | 'awayName'>
): T {
  return l.homeName && l.homeName === e.awayName && l.homeName !== e.homeName
    ? flipLines(l)
    : l;
}

const flipSide = (s: Side | null): Side | null =>
  s === 'home' ? 'away' : s === 'away' ? 'home' : s;

function flipSituation(s: Situation | null): Situation | null {
  if (!s) return s;
  switch (s.kind) {
    case 'football':
      // yardsToGoal is from the possessing team, so only possession moves.
      return { ...s, possession: flipSide(s.possession) };
    case 'baseball':
      // The same team keeps batting: top is the away team's half.
      return { ...s, half: s.half === 'top' ? 'bottom' : 'top' };
    case 'volleyball':
      return {
        ...s,
        sets: s.sets.map((x) => ({ home: x.away, away: x.home })),
      };
    default:
      return s;
  }
}

/** The same game state with home and away exchanged. */
export function flipState(s: GameState): GameState {
  const pw = s.providerWinProb;
  return {
    ...s,
    home: s.away,
    away: s.home,
    winner: s.winner === 'draw' ? 'draw' : flipSide(s.winner),
    providerWinProb: pw && { ...pw, home: pw.away, away: pw.home },
    situation: flipSituation(s.situation),
  };
}

/** Stored lines JSON re-expressed with `newHome` at home. */
function reorientJson(json: string | null, newHome: string): string | null {
  if (!json) return json;
  const l = JSON.parse(json) as OrientedLines;
  // Already tagged with the new orientation (fetched after the swap).
  if (l.homeName === newHome) return json;
  const flipped = flipLines(l);
  return JSON.stringify({ ...flipped, homeName: newHome });
}

export interface Reoriented {
  eventId: string;
  from: string;
  to: string;
  legIds: number[];
}

/**
 * Swap the event's stored home/away to the provider's (`to`): names, abbrs,
 * its current lines and pregame snapshot, its line history, a stored state
 * still in the old orientation, every leg's side and a watch's leader. Lines
 * already tagged with the new home stay as they are. The swap is checked
 * again on the row as it is now, so a second caller holding an old row
 * (another tick, add_bet, the stdio process) does nothing: null. Leg
 * statuses are not touched (the next evaluation re-settles open legs;
 * recompute_bet re-settles the rest).
 */
export function reorientEvent(
  db: DbOrTx,
  eventId: string,
  to: { home: Team; away: Team }
): Reoriented | null {
  const now = new Date().toISOString();
  const run = (tx: DbOrTx): Reoriented | null => {
    const e = tx.select().from(events).where(eq(events.id, eventId)).get();
    if (!e || !isSwapped(e, to.home, to.away)) return null;
    const newHome = e.awayName;
    // A state from before the swap (a listing saw it first) is flipped so
    // row and state always agree; it is refetched on the next tick.
    const st = e.stateJson ? (JSON.parse(e.stateJson) as GameState) : null;
    const staleState = !!st && st.home.name === e.homeName;
    tx.update(events)
      .set({
        homeName: e.awayName,
        awayName: e.homeName,
        homeAbbr: e.awayAbbr,
        awayAbbr: e.homeAbbr,
        providerLinesJson: reorientJson(e.providerLinesJson, newHome),
        pregameOddsJson: reorientJson(e.pregameOddsJson, newHome),
        ...(staleState
          ? { stateJson: JSON.stringify(flipState(st)), nextPollAt: null }
          : {}),
        updatedAt: now,
      })
      .where(eq(events.id, e.id))
      .run();
    for (const row of tx
      .select()
      .from(eventLines)
      .where(eq(eventLines.eventId, e.id))
      .all()) {
      const json = reorientJson(row.linesJson, newHome)!;
      if (json !== row.linesJson)
        tx.update(eventLines)
          .set({ linesJson: json })
          .where(eq(eventLines.id, row.id))
          .run();
    }
    const flip = flipSide;
    const legIds: number[] = [];
    for (const l of tx
      .select()
      .from(legs)
      .where(eq(legs.eventId, e.id))
      .all()) {
      legIds.push(l.id);
      if (l.side)
        tx.update(legs)
          .set({ side: flip(l.side), updatedAt: now })
          .where(eq(legs.id, l.id))
          .run();
    }
    const w = tx.select().from(watches).where(eq(watches.eventId, e.id)).get();
    if (w?.lastLeader)
      tx.update(watches)
        .set({ lastLeader: flip(w.lastLeader) })
        .where(eq(watches.eventId, e.id))
        .run();
    return {
      eventId: e.id,
      from: `${e.awayName} @ ${e.homeName}`,
      to: `${e.homeName} @ ${e.awayName}`,
      legIds,
    };
  };
  return db.transaction((tx) => run(tx));
}
