import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  events,
  follows,
  legs,
  scoreAlerts,
  watches,
  type EventRow,
  type FollowRow,
  type ScoreAlertRow,
  type WatchRow,
} from '../db/schema.js';
import type { Side, Sport } from '../domain/types.js';
import type { Providers } from '../gamestate/registry.js';
import type { ProviderEvent } from '../gamestate/types.js';
import {
  CONFIDENT,
  matchEvent,
  nameScore,
  teamAliases,
  type Candidate,
} from '../matching/match.js';
import { upsertEvent } from '../matching/service.js';
import {
  preState,
  type StateChange,
  type TickResult,
  type Tracker,
} from '../tracker/tracker.js';
import { liveView, type LiveView } from '../tracker/views.js';
import { addDays, localDate } from '../util/date.js';
import {
  detectAlerts,
  inQuietHours,
  leader,
  SPORT_ICON,
  type Alert,
} from './alerts.js';
import type { Notifier } from './ntfy.js';

// The Scores view: games followed for their score, not bet on. Followed teams
// add their upcoming games automatically; single games can be starred. The
// Tracker polls watched games with the bets' games and emits each state
// change, which drives the alerts here.

export interface ScoreOptions {
  /** Days ahead (from today) that followed teams' games are added. */
  followDays: number;
  /** Days ahead searched to resolve a team name (bye weeks). Default 21. */
  resolveDays?: number;
  /** Hours a finished game stays on the board. */
  finalHours: number;
  notifier: Notifier;
  quietHours: string;
  timeZone: string;
  /** Link opened by tapping a push (the Scores page). */
  clickUrl?: string;
  now?: () => Date;
}

export interface GameCard {
  eventId: string;
  sport: Sport;
  icon: string;
  label: string;
  live: LiveView;
  leader: Side | null;
  /** On the board by star/follow (vs only because of a bet). */
  watched: boolean;
  /** Alerts on for this game (watched games only). */
  alerts: boolean;
  /** A followed team's game (unstarring hides it rather than deleting). */
  followed: boolean;
  /** Has an open bet leg. */
  bet: boolean;
}

export interface FollowView {
  id: number;
  sport: Sport;
  icon: string;
  team: string;
  alerts: boolean;
}

export interface AlertView {
  eventId: string;
  kind: ScoreAlertRow['kind'];
  title: string;
  body: string;
  at: string;
  delivery: string;
}

export interface ScoreBoard {
  live: GameCard[];
  upcoming: GameCard[];
  final: GameCard[];
  follows: FollowView[];
  alerts: AlertView[];
  pushConfigured: boolean;
  quietHours: string;
}

export interface ScheduleGame {
  eventId: string;
  sport: Sport;
  label: string;
  startTime: string;
  status: ProviderEvent['status'];
  watched: boolean;
}

export type FollowResult =
  | { status: 'followed'; follow: FollowView; games: GameCard[] }
  | { status: 'ambiguous'; candidates: string[] }
  | { status: 'not_found'; near: string[]; searched: string };

export type WatchResult =
  | { status: 'watching'; game: GameCard }
  | { status: 'needs_choice'; candidates: ScheduleGame[] }
  | { status: 'not_found'; searched: string };

const label = (e: { sport: Sport; homeName: string; awayName: string }) =>
  e.sport === 'mma'
    ? `${e.homeName} v ${e.awayName}`
    : `${e.awayName} @ ${e.homeName}`;

const providerLabel = (e: ProviderEvent) =>
  label({ sport: e.sport, homeName: e.home.name, awayName: e.away.name });

/** "Packers @ Bears", "Packers vs Bears", "Bears" -> one or two names. */
export function parseTeams(s: string): string[] {
  return s
    .split(/\s+(?:@|at|vs\.?|v\.?)\s+/i)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 2);
}

/**
 * Add nickname/place aliases ("White Sox", "Chicago") to every side: MLB
 * Stats API events only carry full names. Scores lookups only; bet matching
 * keeps the provider's aliases.
 */
function withNicknames(e: ProviderEvent): ProviderEvent {
  const more = (side: ProviderEvent['home']) => ({
    ...side,
    aliases: [...new Set([...side.aliases, ...teamAliases(side.name)])],
  });
  return { ...e, home: more(e.home), away: more(e.away) };
}

const RESOLVE_DAYS = 21;

/** Every listed team by how well `team` names it, best first. */
function rankTeams(team: string, listed: ProviderEvent[]): [string, number][] {
  const best = new Map<string, number>();
  for (const e of listed) {
    for (const side of [e.home, e.away]) {
      const sc = nameScore(team, side.aliases);
      best.set(side.name, Math.max(best.get(side.name) ?? 0, sc));
    }
  }
  return [...best].sort((a, b) => b[1] - a[1]);
}

const followView = (f: FollowRow): FollowView => ({
  id: f.id,
  sport: f.sport,
  icon: SPORT_ICON[f.sport],
  team: f.teamName,
  alerts: f.alerts,
});

const iso = (d: Date) => d.toISOString();

export class ScoreService {
  private readonly now: () => Date;
  private readonly inflight = new Set<Promise<void>>();

  constructor(
    private readonly db: Db,
    private readonly providers: Providers,
    private readonly tracker: Tracker,
    private readonly opts: ScoreOptions
  ) {
    this.now = opts.now ?? (() => new Date());
    tracker.on('state', (c: StateChange) => {
      try {
        this.onState(c);
      } catch (e) {
        console.warn(`scores: alert check failed: ${(e as Error).message}`);
      }
    });
  }

  get pushConfigured() {
    return this.opts.notifier.configured;
  }

  /** Wait for alert deliveries in flight (tests). */
  async flush() {
    await Promise.all([...this.inflight]);
  }

  private today() {
    return localDate(iso(this.now()), this.opts.timeZone);
  }

  private dates(from: string, days: number) {
    return Array.from({ length: Math.max(1, days) }, (_, i) =>
      addDays(from, i)
    );
  }

  private async listings(sport: Sport, dates: string[]) {
    const p = this.providers.forSport(sport);
    const out = new Map<string, ProviderEvent>();
    for (const d of dates) {
      for (const e of await p.listEvents(sport, d))
        out.set(e.id, withNicknames(e));
    }
    return [...out.values()];
  }

  // --- Follows ---------------------------------------------------------------

  listFollows(): FollowView[] {
    return this.db
      .select()
      .from(follows)
      .orderBy(follows.sport, follows.teamName)
      .all()
      .map(followView);
  }

  /**
   * Follow a team by (fuzzy) name. Resolves it to the provider's full team
   * name from the next `followDays` of games; never guesses between teams
   * ("Chicago" in MLB is ambiguous).
   */
  async followTeam(
    sport: Sport,
    team: string,
    alerts = true
  ): Promise<FollowResult> {
    const today = this.today();
    const week = this.dates(today, this.opts.followDays);
    let listed = await this.listings(sport, week);
    let ranked = rankTeams(team, listed);
    // A bye week or a gap between series: look further ahead for the name.
    const resolveDays = this.opts.resolveDays ?? RESOLVE_DAYS;
    if ((ranked[0]?.[1] ?? 0) < CONFIDENT && resolveDays > week.length) {
      const later = this.dates(
        addDays(today, week.length),
        resolveDays - week.length
      );
      listed = [...listed, ...(await this.listings(sport, later))];
      ranked = rankTeams(team, listed);
    }
    const top = ranked[0]?.[1] ?? 0;
    if (top < CONFIDENT) {
      return {
        status: 'not_found',
        near: ranked
          .filter(([, s]) => s >= 0.5)
          .slice(0, 5)
          .map(([n]) => n),
        searched: `${sport} games ${today} + ${Math.max(resolveDays, week.length)} days`,
      };
    }
    const names = ranked
      .filter(([, s]) => (top === 1 ? s === 1 : s >= CONFIDENT))
      .map(([n]) => n);
    if (names.length > 1) return { status: 'ambiguous', candidates: names };

    this.db
      .insert(follows)
      .values({ sport, teamName: names[0]!, alerts })
      .onConflictDoUpdate({
        target: [follows.sport, follows.teamName],
        set: { alerts },
      })
      .run();
    const f = this.db
      .select()
      .from(follows)
      .where(and(eq(follows.sport, sport), eq(follows.teamName, names[0]!)))
      .get()!;
    // Only this week's games go on the board; discovery adds later ones.
    const horizon = addDays(today, week.length);
    const added = this.addFollowedGames(
      [f],
      listed.filter((e) => localDate(e.startTime, this.opts.timeZone) < horizon)
    );
    await this.refresh();
    return {
      status: 'followed',
      follow: followView(f),
      games: this.cards(added),
    };
  }

  unfollowTeam(followId: number): FollowView {
    const f = this.db
      .select()
      .from(follows)
      .where(eq(follows.id, followId))
      .get();
    if (!f) throw new Error(`Not following team ${followId}`);
    this.db
      .delete(watches)
      .where(and(eq(watches.followId, followId), eq(watches.source, 'follow')))
      .run();
    this.db.delete(follows).where(eq(follows.id, followId)).run();
    this.changed();
    return followView(f);
  }

  /** Watch every listed game a followed team plays; returns their ids. */
  private addFollowedGames(fs: FollowRow[], listed: ProviderEvent[]) {
    const added: string[] = [];
    for (const e of listed) {
      const f = fs.find(
        (f) =>
          f.sport === e.sport &&
          (nameScore(f.teamName, e.home.aliases) === 1 ||
            nameScore(f.teamName, e.away.aliases) === 1)
      );
      if (!f) continue;
      upsertEvent(this.db, e);
      this.db
        .insert(watches)
        .values({
          eventId: e.id,
          source: 'follow',
          followId: f.id,
          alerts: f.alerts,
        })
        .onConflictDoNothing()
        .run();
      added.push(e.id);
    }
    return added;
  }

  /** Scan the schedule for followed teams' games (run periodically). */
  async discover(): Promise<{ added: number; errors: string[] }> {
    const all = this.db.select().from(follows).all();
    const errors: string[] = [];
    let added = 0;
    const dates = this.dates(this.today(), this.opts.followDays);
    for (const sport of new Set(all.map((f) => f.sport))) {
      try {
        const listed = await this.listings(sport, dates);
        added += this.addFollowedGames(
          all.filter((f) => f.sport === sport),
          listed
        ).length;
      } catch (e) {
        errors.push(`${sport}: ${(e as Error).message}`);
      }
    }
    return { added, errors };
  }

  // --- Single games -----------------------------------------------------------

  /** A sport's games on a local date, flagged when already watched. */
  async schedule(sport: Sport, date = this.today()): Promise<ScheduleGame[]> {
    const listed = await this.providers.forSport(sport).listEvents(sport, date);
    return this.scheduleGames(listed);
  }

  private scheduleGames(listed: ProviderEvent[]): ScheduleGame[] {
    const ids = listed.map((e) => e.id);
    const visible = new Set(
      ids.length
        ? this.db
            .select({ id: watches.eventId })
            .from(watches)
            .where(
              and(inArray(watches.eventId, ids), eq(watches.hidden, false))
            )
            .all()
            .map((r) => r.id)
        : []
    );
    return listed
      .map((e) => ({
        eventId: e.id,
        sport: e.sport,
        label: providerLabel(e),
        startTime: e.startTime,
        status: e.status,
        watched: visible.has(e.id),
      }))
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
  }

  /**
   * Star a game by its event id (from schedule) or team name(s) on a date.
   * Anything but exactly one confident game comes back as choices.
   */
  async watchGame(q: {
    sport: Sport;
    date?: string;
    eventId?: string;
    teams?: string;
    alerts?: boolean;
  }): Promise<WatchResult> {
    const date = q.date ?? this.today();
    const listed = (
      await this.providers.forSport(q.sport).listEvents(q.sport, date)
    ).map(withNicknames);
    const searched = `${q.sport} on ${date}`;
    let hit: ProviderEvent | undefined;
    if (q.eventId) {
      hit = listed.find((e) => e.id === q.eventId);
      if (!hit) return { status: 'not_found', searched };
    } else {
      const names = parseTeams(q.teams ?? '');
      if (!names.length) throw new Error('Give an eventId or team name(s)');
      let found: Candidate[];
      if (names.length === 2) {
        const r = matchEvent(names as [string, string], listed);
        found = r.status === 'matched' ? [r.candidate] : r.candidates;
      } else {
        found = listed
          .map((event) => ({
            event,
            score: Math.max(
              nameScore(names[0]!, event.home.aliases),
              nameScore(names[0]!, event.away.aliases)
            ),
            sides: ['home', 'away'] as [Side, Side],
          }))
          .filter((c) => c.score >= 0.5)
          .sort((a, b) => b.score - a.score);
      }
      const confident = found.filter((c) => c.score >= CONFIDENT);
      if (confident.length === 1) hit = confident[0]!.event;
      else if (!found.length) return { status: 'not_found', searched };
      else
        return {
          status: 'needs_choice',
          candidates: this.scheduleGames(found.slice(0, 5).map((c) => c.event)),
        };
    }
    upsertEvent(this.db, hit);
    this.db
      .insert(watches)
      .values({ eventId: hit.id, source: 'manual', alerts: q.alerts ?? true })
      .onConflictDoUpdate({
        target: watches.eventId,
        set: {
          hidden: false,
          ...(q.alerts == null ? {} : { alerts: q.alerts }),
        },
      })
      .run();
    await this.refresh();
    return { status: 'watching', game: this.cards([hit.id])[0]! };
  }

  /** Unstar: followed-team games are hidden (so they aren't re-added). */
  unwatchGame(eventId: string): void {
    const w = this.watch(eventId);
    if (!w || w.hidden) throw new Error(`Not watching ${eventId}`);
    if (w.source === 'follow') {
      this.db
        .update(watches)
        .set({ hidden: true })
        .where(eq(watches.eventId, eventId))
        .run();
    } else {
      this.db.delete(watches).where(eq(watches.eventId, eventId)).run();
    }
    this.changed();
  }

  /** Alerts on/off for one game, or a followed team (and its games). */
  setAlerts(
    target: { eventId: string } | { followId: number },
    on: boolean
  ): void {
    if ('eventId' in target) {
      if (!this.watch(target.eventId))
        throw new Error(`Not watching ${target.eventId}`);
      this.db
        .update(watches)
        .set({ alerts: on })
        .where(eq(watches.eventId, target.eventId))
        .run();
    } else {
      const r = this.db
        .update(follows)
        .set({ alerts: on })
        .where(eq(follows.id, target.followId))
        .run();
      if (r.changes === 0)
        throw new Error(`Not following team ${target.followId}`);
      this.db
        .update(watches)
        .set({ alerts: on })
        .where(eq(watches.followId, target.followId))
        .run();
    }
    this.changed();
  }

  private watch(eventId: string): WatchRow | undefined {
    return this.db
      .select()
      .from(watches)
      .where(eq(watches.eventId, eventId))
      .get();
  }

  /** Re-render live pages (the board changed without a poll). */
  private changed() {
    const r: TickResult = {
      polled: [],
      evaluatedEvents: [],
      changedBets: [],
      errors: [],
    };
    this.tracker.emit('change', r);
  }

  /** Fetch new games' state now rather than on the next background tick. */
  private async refresh() {
    try {
      await this.tracker.tick();
    } catch {
      // The background poller catches up.
    }
  }

  // --- Board -----------------------------------------------------------------

  private cards(ids: string[]): GameCard[] {
    if (!ids.length) return [];
    const rows = this.db
      .select({ e: events, w: watches })
      .from(events)
      .leftJoin(watches, eq(watches.eventId, events.id))
      .where(inArray(events.id, ids))
      .all();
    const betIds = new Set(
      this.db
        .selectDistinct({ id: legs.eventId })
        .from(legs)
        .where(and(eq(legs.status, 'open'), inArray(legs.eventId, ids)))
        .all()
        .map((r) => r.id)
    );
    return rows.map(({ e, w }) => this.card(e, w, betIds.has(e.id)));
  }

  private card(e: EventRow, w: WatchRow | null, bet: boolean): GameCard {
    const state = e.stateJson ? JSON.parse(e.stateJson) : preState(e);
    const live = liveView({ ...e, stateJson: JSON.stringify(state) })!;
    const watched = !!w && !w.hidden;
    return {
      eventId: e.id,
      sport: e.sport,
      icon: SPORT_ICON[e.sport],
      label: label(e),
      live,
      leader: e.sport === 'mma' ? null : leader(state),
      watched,
      alerts: watched && w.alerts,
      followed: w?.source === 'follow',
      bet,
    };
  }

  /** Watched games and games with an open bet: live, upcoming, recent finals. */
  board(): ScoreBoard {
    const now = this.now();
    const watchedIds = this.db
      .select({ id: watches.eventId })
      .from(watches)
      .where(eq(watches.hidden, false))
      .all()
      .map((r) => r.id);
    const betIds = this.db
      .selectDistinct({ id: legs.eventId })
      .from(legs)
      .where(eq(legs.status, 'open'))
      .all()
      .map((r) => r.id!)
      .filter(Boolean);
    const all = this.cards([...new Set([...watchedIds, ...betIds])]);
    const horizon = iso(new Date(now.getTime() + this.opts.followDays * 864e5));
    const finalSince = iso(
      new Date(now.getTime() - this.opts.finalHours * 3600e3)
    );
    const byStart = (a: GameCard, b: GameCard) =>
      a.live.startTime.localeCompare(b.live.startTime);
    const finals = all.filter((c) => c.live.status === 'final');
    const alerts = this.db
      .select()
      .from(scoreAlerts)
      .where(gte(scoreAlerts.createdAt, finalSince))
      .orderBy(desc(scoreAlerts.createdAt))
      .limit(10)
      .all();
    return {
      live: all.filter((c) => c.live.status === 'in').sort(byStart),
      upcoming: all
        .filter((c) => c.live.status === 'pre' && c.live.startTime <= horizon)
        .sort(byStart),
      final: finals
        .filter((c) => (c.live.fetchedAt || c.live.startTime) >= finalSince)
        .sort((a, b) => byStart(b, a)),
      follows: this.listFollows(),
      alerts: alerts.map((a) => ({
        eventId: a.eventId,
        kind: a.kind,
        title: a.title,
        body: a.body,
        at: a.createdAt,
        delivery: a.delivery,
      })),
      pushConfigured: this.pushConfigured,
      quietHours: this.opts.quietHours,
    };
  }

  // --- Alerts ----------------------------------------------------------------

  private onState({ event, prev, next }: StateChange) {
    const w = this.watch(event.id);
    if (!w || w.hidden) return;
    const d = detectAlerts(prev, next, w.lastLeader);
    if (d.lastLeader !== w.lastLeader) {
      this.db
        .update(watches)
        .set({ lastLeader: d.lastLeader })
        .where(eq(watches.eventId, event.id))
        .run();
    }
    if (!w.alerts) return;
    for (const a of d.alerts) this.record(event.id, a);
  }

  /** Log an alert once per (event, key) and push it unless quiet/off. */
  private record(eventId: string, a: Alert) {
    const now = this.now();
    const quiet = inQuietHours(this.opts.quietHours, now, this.opts.timeZone);
    const delivery = quiet
      ? 'quiet'
      : this.opts.notifier.configured
        ? 'pending'
        : 'off';
    const row = this.db
      .insert(scoreAlerts)
      .values({
        eventId,
        kind: a.kind,
        key: a.key,
        title: a.title,
        body: a.body,
        createdAt: iso(now),
        delivery,
      })
      .onConflictDoNothing()
      .returning()
      .get();
    if (!row || delivery !== 'pending') return;
    const p = this.opts.notifier
      .send({
        kind: a.kind,
        title: a.title,
        body: a.body,
        click: this.opts.clickUrl,
      })
      .then(
        () => 'sent',
        (e: Error) => `error: ${e.message}`
      )
      .then((result) => {
        this.db
          .update(scoreAlerts)
          .set({ delivery: result })
          .where(eq(scoreAlerts.id, row.id))
          .run();
        if (result !== 'sent') console.warn(`scores: push failed: ${result}`);
      })
      .finally(() => this.inflight.delete(p));
    this.inflight.add(p);
  }
}
