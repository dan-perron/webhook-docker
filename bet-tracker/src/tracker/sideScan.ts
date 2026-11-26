import { eq, isNotNull, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { bets, events, legs, series } from '../db/schema.js';
import type { Side } from '../domain/types.js';
import type { GameState } from '../gamestate/types.js';
import { isSwapped, sideOfTeam, type Team } from './orientation.js';

export interface SideScanRow {
  betId: number;
  legId: number;
  betStatus: string;
  legStatus: string;
  legModel: string | null;
  sport: string;
  market: string;
  selection: string;
  line: number | null;
  eventId: string;
  /** ESPN's latest away @ home (state, else the stored row). */
  matchup: string;
  storedSide: Side | null;
  /** The team the stored side picks out in ESPN's latest orientation. */
  pricedTeam: string | null;
  /** The selected team's side by name in ESPN's latest orientation. */
  espnSide: Side | null;
  /** The event row's home/away is the other way round from its state. */
  rowSwapped: boolean;
  problem: string;
  /** A settled game leg's result on the right side, from the final score. */
  correctResult?: 'won' | 'lost' | 'push';
  final?: string;
}

/**
 * Every matched team leg (game or series; a prop's team) with its stored side
 * against the side derived from ESPN by name. Lists mismatches and legs
 * whose side can't be derived (`all` lists every leg). Read-only.
 */
export function scanSides(db: Db, opts: { all?: boolean } = {}): SideScanRow[] {
  const rows = db
    .select({ leg: legs, bet: bets })
    .from(legs)
    .innerJoin(bets, eq(bets.id, legs.betId))
    .where(or(isNotNull(legs.eventId), isNotNull(legs.seriesId)))
    .all();
  const out: SideScanRow[] = [];
  for (const { leg: l, bet } of rows) {
    if (!l.selectionTeam) continue;
    if (l.selectionKind !== 'team' && l.market !== 'player_prop') continue;
    let home: Team, away: Team;
    let rowSwapped = false;
    let st: GameState | null = null;
    if (l.eventId) {
      const e = db.select().from(events).where(eq(events.id, l.eventId)).get();
      if (!e) continue;
      st = e.stateJson ? (JSON.parse(e.stateJson) as GameState) : null;
      rowSwapped = !!st && isSwapped(e, st.home, st.away);
      // The state is what was priced and settled against.
      home = st ? st.home : { name: e.homeName, abbr: e.homeAbbr };
      away = st ? st.away : { name: e.awayName, abbr: e.awayAbbr };
    } else {
      const s = db
        .select()
        .from(series)
        .where(eq(series.id, l.seriesId!))
        .get();
      if (!s) continue;
      home = { name: s.homeName, abbr: s.homeAbbr };
      away = { name: s.awayName, abbr: s.awayAbbr };
    }
    const espnSide = sideOfTeam(l.selectionTeam, home, away);
    const pricedTeam =
      l.side === 'home' ? home.name : l.side === 'away' ? away.name : null;
    let correctResult: SideScanRow['correctResult'];
    let final: string | undefined;
    if (st?.status === 'final' && !st.cancelled && espnSide) {
      final = `${away.abbr ?? away.name} ${st.away.score} @ ${home.abbr ?? home.name} ${st.home.score}`;
      const margin =
        espnSide === 'home'
          ? st.home.score - st.away.score
          : st.away.score - st.home.score;
      // By the provider's winner (fights have no score), as settlement does.
      if (l.market === 'moneyline')
        correctResult =
          st.winner === espnSide
            ? 'won'
            : st.winner === 'draw'
              ? 'push'
              : st.winner
                ? 'lost'
                : margin > 0
                  ? 'won'
                  : margin < 0
                    ? 'lost'
                    : 'push';
      else if (l.market === 'spread' && l.line != null) {
        const m = margin + l.line;
        correctResult = m > 0 ? 'won' : m < 0 ? 'lost' : 'push';
      }
    }
    // A side that is right now can still carry a result settled while it
    // was wrong (e.g. another bet's recompute re-oriented the event).
    const wrongStatus =
      !!correctResult &&
      l.status !== 'open' &&
      l.model !== 'manual' &&
      l.status !== correctResult;
    const problem = !espnSide
      ? `no confident name match for ${l.selectionTeam}`
      : espnSide !== l.side
        ? `prices ${pricedTeam ?? 'nobody'}, not ${l.selectionTeam}`
        : wrongStatus
          ? `leg ${l.status}, the final says ${correctResult}`
          : 'ok';
    if (problem === 'ok' && !opts.all) continue;
    const row: SideScanRow = {
      betId: bet.id,
      legId: l.id,
      betStatus: bet.status,
      legStatus: l.status,
      legModel: l.model,
      sport: l.sport,
      market: l.market,
      selection: l.selectionTeam,
      line: l.line,
      eventId: l.eventId ?? l.seriesId!,
      matchup: `${away.name} @ ${home.name}`,
      storedSide: l.side,
      pricedTeam,
      espnSide,
      rowSwapped,
      problem,
    };
    if (final) row.final = final;
    if (correctResult) row.correctResult = correctResult;
    out.push(row);
  }
  return out;
}
