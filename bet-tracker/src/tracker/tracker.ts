import { EventEmitter } from 'node:events';
import { and, desc, eq, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import {
  bets,
  events,
  legs,
  predictionSnapshots,
  series,
  watches,
  type EventRow,
  type BetRow,
  type LegRow,
  type SeriesRow,
} from '../db/schema.js';
import { betSettledAt, eventFinalAt } from '../domain/settleTime.js';

import { betStatus } from '../domain/value.js';
import type { Providers } from '../gamestate/registry.js';
import type {
  GameState,
  PlayerStats,
  PregameLines,
  SeriesState,
} from '../gamestate/types.js';
import { matchLegs } from '../matching/service.js';
import {
  bookKeyFor,
  closeFromOdds,
  closeMarket,
  closeWindows,
  quotaBelowFloor,
  unavailableClose,
  type CloseCandidate,
  type CloseWindow,
  type LegClose,
} from './clv.js';
import { linesAsOf, recordLines } from './lines.js';
import {
  findOddsEvent,
  linesForEvent,
  summarizeEvent,
  type EventOdds,
} from '../odds/consensus.js';
import {
  HistoricalUnavailableError,
  sportKey,
  type OddsApiClient,
  type OddsEvent,
  type OddsMarket,
} from '../odds/oddsApi.js';
import type { JointOutcome } from '../domain/value.js';
import {
  anchorShift,
  evaluateEvent,
  jointOutcomes,
} from '../models/evaluate.js';
import { ensureFit } from '../models/fit.js';
import {
  marketFor,
  resolvePrior,
  type EnteredLeg,
  type LinesInput,
  type ModelParams,
  type Prior,
} from '../models/prior.js';
import {
  DEFAULT_PROP_PARAMS,
  evaluateProp,
  PROP_SPECS,
  propPregame,
  type PropParams,
} from '../models/props.js';
import {
  evaluateSeries,
  seriesJoint,
  seriesPmf,
  stateAsOf,
  strengthForPrice,
  strengthFromGame,
  type SeriesStrength,
} from '../models/series.js';
import type { ModelSelection } from '../models/types.js';
import { devigSingle } from '../odds/math.js';

export interface TrackerOptions {
  params: ModelParams;
  /** Assumed holds and live-model settings for player props. */
  props?: Partial<PropParams>;
  polling: { liveSeconds: number; scheduledSeconds: number };
  /** Minimum minutes between calibration snapshots of a live leg. */
  snapshotEveryMinutes?: number;
  /** Minutes between retries for legs that matched no event. */
  rematchEveryMinutes?: number;
  now?: () => Date;
  /**
   * Optional one-time Odds API snapshot per event shortly before it starts,
   * used as the prior only when ESPN publishes no lines (e.g. UFC).
   */
  pregameSnapshot?: {
    client: OddsApiClient;
    enabled: boolean;
    leadMinutes: number;
  };
  /** Closing-line snapshots (tracker/clv.ts). */
  clv?: {
    client: OddsApiClient;
    enabled: boolean;
    leadMinutes: number;
    windowMinutes: number;
    retrySeconds: number;
    quotaFloor: number;
    /**
     * Use Odds API historical odds (paid plans; 10x a live call) for a game
     * that started before its snapshot. Off = those legs are `missed`.
     */
    historical?: boolean;
  };
}

/** A leg waiting for its close, with its event and bet. */
interface CloseItem {
  leg: LegRow;
  e: EventRow;
  bet: BetRow;
}

export interface CloseBackfillReport {
  /** Settled legs with no close, or only a `missed` stamp. */
  missingClose: number;
  /** Of those, legs historical odds could price. */
  eligible: number;
  /** The rest, by reason. */
  skipped: Record<string, number>;
  windows: number;
  /** Requests the windows cost (historical = 10 x markets x regions). */
  estimatedCost: number;
  /** null = not asked (dry run, or nothing to fetch). */
  planAvailable: boolean | null;
  filled: number;
  spent: number;
  errors: string[];
}

/** A polled game's state change (prev null on its first fetch). */
export interface StateChange {
  event: EventRow;
  prev: GameState | null;
  next: GameState;
}

export interface TickResult {
  polled: string[];
  evaluatedEvents: string[];
  changedBets: number[];
  errors: string[];
}

/** A same-game joint outcome as stored on the bet (legs by id). */
export interface StoredJoint {
  p: number;
  pushedLegIds: number[];
}

const iso = (d: Date) => d.toISOString();
const fmtPrice = (p: number) => (p > 0 ? `+${p}` : `${p}`);

function groupBy<T, K>(xs: T[], key: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
}

/** Joint outcomes as stored on the bet (legs by id, not position). */
function toStored(ls: LegRow[], outs: JointOutcome[]): StoredJoint[] {
  return outs.map((o) => ({
    p: o.p,
    pushedLegIds: o.pushed.map((i) => ls[i]!.id),
  }));
}
const addSeconds = (d: Date, s: number) => new Date(d.getTime() + s * 1000);

/** A not-yet-fetched event, as a pre-game state. */
export function preState(e: EventRow): GameState {
  return {
    eventId: e.id,
    sport: e.sport,
    status: 'pre',
    cancelled: false,
    startTime: e.startTime,
    home: { name: e.homeName, abbr: e.homeAbbr, score: 0 },
    away: { name: e.awayName, abbr: e.awayAbbr, score: 0 },
    period: null,
    clockSeconds: null,
    detail: 'Scheduled',
    fractionRemaining: 1,
    situation: null,
    winner: null,
    providerWinProb: null,
    fetchedAt: e.updatedAt,
  };
}

const isProp = (l: LegRow) => l.market === 'player_prop';

/** A player prop's pregame P(win): its entered price de-vigged. */
function propPlacement(l: LegRow, params: PropParams) {
  const { p, hold } = propPregame(l.propType!, l.priceAmerican, params);
  return {
    p,
    prior: {
      source: 'entered_price' as const,
      price: l.priceAmerican,
      hold,
      p,
      detail: `${fmtPrice(l.priceAmerican)} de-vigged at ${Math.round(hold * 1000) / 10}% assumed ${PROP_SPECS[l.propType!].label} hold`,
    },
  };
}

/** One leg's new evaluation, to be written with its bet's settlement. */
type LegUpdate = {
  leg: LegRow;
  ev: {
    outcome: { win: number; push: number };
    status: LegRow['status'];
    model: string;
    inputs: Record<string, number | string | null>;
  };
  anchor: { shift: number | null; source: string | null };
  prior: { source: Prior['source'] };
};

/** Placement values and joints computed for legs missing them. */
type Placement = {
  legs: Map<number, { win: number; push: number; json: string }>;
  joints: { betId: number; outcomes: StoredJoint[] }[];
};

const selectionOf = (l: LegRow): ModelSelection => ({
  market: l.market,
  kind: l.selectionKind,
  side: l.side,
  line: l.line,
});

/**
 * Polls game state for events with open legs and watched games (Scores),
 * keeps priors and leg probabilities current, settles finished legs and bets,
 * and logs calibration snapshots. Emits 'change' with a TickResult when
 * anything moved and 'state' with a StateChange per polled event.
 */
export class Tracker extends EventEmitter {
  private readonly now: () => Date;
  private readonly props: PropParams;
  private lastRematch = 0;
  private readonly matchAttempted = new Set<number>();
  private running = false;
  /** Failed closing snapshots by window: tries so far and when last tried. */
  private readonly clvTries = new Map<string, { count: number; at: number }>();
  /** The month the quota floor was last logged, so it logs once. */
  private clvFloorLogged: string | null = null;

  constructor(
    private readonly db: Db,
    private readonly providers: Providers,
    private readonly opts: TrackerOptions
  ) {
    super();
    this.now = opts.now ?? (() => new Date());
    this.props = { ...DEFAULT_PROP_PARAMS, ...opts.props };
  }

  /** One polling pass. Safe to call often; does nothing until work is due. */
  async tick(): Promise<TickResult> {
    const result: TickResult = {
      polled: [],
      evaluatedEvents: [],
      changedBets: [],
      errors: [],
    };
    if (this.running) return result;
    this.running = true;
    try {
      await this.rematch(result);
      const due = this.dueEvents();
      // Lines and snapshots only matter (and cost quota) for bets.
      const betDue = due.filter((e) => this.hasOpenLeg(e.id));
      await this.refreshLines(betDue, result);
      await this.pregameSnapshots(betDue, result);
      await this.closingSnapshots(result);
      await this.pollStates(due, result);
      const withStats = await this.refreshPlayerStats(result);
      const polledSeries = await this.pollSeries(result);
      for (const id of new Set([
        ...result.polled.filter((id) => !polledSeries.includes(id)),
        ...withStats,
        ...this.unevaluatedEventIds(),
      ])) {
        this.evaluate(id, result);
      }
      for (const id of new Set([
        ...polledSeries,
        ...this.unevaluatedSeriesIds(),
      ])) {
        this.evaluateSeriesLegs(id, result);
      }
    } finally {
      this.running = false;
    }
    if (
      result.changedBets.length ||
      result.evaluatedEvents.length ||
      result.polled.length
    )
      this.emit('change', result);
    return result;
  }

  /**
   * Match unmatched legs on open bets: legs this process hasn't tried yet
   * (e.g. seeded or added by the stdio MCP) right away, and ones that
   * already failed every so often (events get listed late).
   */
  private async rematch(result: TickResult) {
    const every = (this.opts.rematchEveryMinutes ?? 10) * 60_000;
    const retryDue = this.now().getTime() - this.lastRematch >= every;
    const ids = this.db
      .select({ id: legs.id })
      .from(legs)
      .innerJoin(bets, eq(bets.id, legs.betId))
      .where(and(eq(legs.matchStatus, 'unmatched'), eq(bets.status, 'open')))
      .all()
      .map((r) => r.id)
      .filter((id) => retryDue || !this.matchAttempted.has(id));
    if (ids.length === 0) return;
    if (retryDue) this.lastRematch = this.now().getTime();
    for (const id of ids) this.matchAttempted.add(id);
    try {
      await matchLegs(this.db, this.providers, ids);
    } catch (e) {
      result.errors.push(`match: ${(e as Error).message}`);
    }
  }

  /**
   * Events with an open leg or a (visible) watch whose next poll is due, plus
   * any never fetched (a leg matched to an already-final game still needs its
   * final state). Legs of settled bets (e.g. a dead parlay) keep polling until
   * their game ends so their calibration snapshots get an outcome.
   */
  private dueEvents(): EventRow[] {
    const now = iso(this.now());
    const due = or(
      isNull(events.stateJson),
      and(
        ne(events.status, 'final'),
        or(isNull(events.nextPollAt), lte(events.nextPollAt, now))
      )
    );
    const withLegs = this.db
      .selectDistinct({ e: events })
      .from(events)
      .innerJoin(legs, eq(legs.eventId, events.id))
      .where(and(eq(legs.status, 'open'), due))
      .all();
    const watched = this.db
      .select({ e: events })
      .from(events)
      .innerJoin(watches, eq(watches.eventId, events.id))
      .where(and(eq(watches.hidden, false), due))
      .all();
    const byId = new Map<string, EventRow>();
    for (const { e } of [...withLegs, ...watched]) byId.set(e.id, e);
    return [...byId.values()];
  }

  /** An open game-market leg (props don't use game lines). */
  private hasOpenLeg(eventId: string): boolean {
    return !!this.db
      .select({ id: legs.id })
      .from(legs)
      .where(
        and(
          eq(legs.eventId, eventId),
          eq(legs.status, 'open'),
          ne(legs.market, 'player_prop')
        )
      )
      .get();
  }

  /**
   * Box scores for started events with an open player prop leg: with each
   * live poll, then after the final until the provider marks the box score
   * complete (gives up a day after the start). Returns the events fetched.
   */
  private async refreshPlayerStats(result: TickResult): Promise<string[]> {
    const rows = this.db
      .selectDistinct({ e: events })
      .from(events)
      .innerJoin(legs, eq(legs.eventId, events.id))
      .where(
        and(
          eq(legs.status, 'open'),
          eq(legs.market, 'player_prop'),
          ne(events.status, 'pre')
        )
      )
      .all();
    const now = this.now();
    const fetched: string[] = [];
    for (const { e } of rows) {
      const prev = e.playerStatsJson
        ? (JSON.parse(e.playerStatsJson) as PlayerStats)
        : null;
      if (prev?.final) continue;
      const due =
        result.polled.includes(e.id) ||
        !e.playerStatsAt ||
        addSeconds(new Date(e.playerStatsAt), this.opts.polling.liveSeconds) <=
          now;
      const tooOld =
        e.status === 'final' &&
        now.getTime() - new Date(e.startTime).getTime() > 24 * 3600_000;
      if (!due || tooOld) continue;
      let stats: PlayerStats | null = null;
      try {
        stats = await this.providers.playerStats(e);
      } catch (err) {
        result.errors.push(`box score ${e.id}: ${(err as Error).message}`);
      }
      this.db
        .update(events)
        .set({
          ...(stats
            ? {
                playerStatsJson: JSON.stringify({
                  ...stats,
                  fetchedAt: iso(now),
                }),
              }
            : {}),
          playerStatsAt: iso(now),
        })
        .where(eq(events.id, e.id))
        .run();
      if (stats) fetched.push(e.id);
    }
    return fetched;
  }

  /** Events with open legs that have never been evaluated (new bets, priors). */
  private unevaluatedEventIds(): string[] {
    return this.db
      .selectDistinct({ id: legs.eventId })
      .from(legs)
      .where(
        and(
          eq(legs.status, 'open'),
          eq(legs.matchStatus, 'matched'),
          isNull(legs.evaluatedAt)
        )
      )
      .all()
      .map((r) => r.id!)
      .filter(Boolean);
  }

  /**
   * Pregame: refresh lines each scheduled poll. After the start: fetch the
   * closing line once if we never got one, then leave it alone.
   */
  private async refreshLines(due: EventRow[], result: TickResult) {
    const now = this.now();
    for (const e of due) {
      const stale =
        e.status === 'pre'
          ? !e.providerLinesAt ||
            addSeconds(
              new Date(e.providerLinesAt),
              this.opts.polling.scheduledSeconds
            ) <= now
          : !e.providerLinesAt;
      if (!stale) continue;
      let lines: PregameLines | null = null;
      try {
        lines = await this.providers.pregameLines(e);
      } catch (err) {
        result.errors.push(`lines ${e.id}: ${(err as Error).message}`);
        continue;
      }
      this.db
        .update(events)
        .set({
          // Keep the last good line if a refresh comes back empty.
          ...(lines ? { providerLinesJson: JSON.stringify(lines) } : {}),
          providerLinesAt: iso(now),
        })
        .where(eq(events.id, e.id))
        .run();
      if (lines) recordLines(this.db, e.id, 'espn', lines, iso(now));
    }
  }

  /** Markets worth paying for in a snapshot, per sport. */
  private static snapshotMarkets(e: EventRow): OddsMarket[] {
    if (e.sport === 'mma') return ['h2h'];
    if (e.sport === 'soccer') return ['h2h', 'totals'];
    return ['h2h', 'spreads', 'totals'];
  }

  private async pregameSnapshots(due: EventRow[], result: TickResult) {
    const snap = this.opts.pregameSnapshot;
    if (!snap?.enabled || !snap.client.configured) return;
    const now = this.now();
    for (const e of due) {
      const minutesToStart =
        (new Date(e.startTime).getTime() - now.getTime()) / 60_000;
      if (
        e.status !== 'pre' ||
        e.pregameOddsAt ||
        e.providerLinesJson ||
        minutesToStart > snap.leadMinutes ||
        minutesToStart < 0
      ) {
        continue;
      }
      let json: string | null = null;
      try {
        // One call per sport covers every event on it (and is cached).
        const odds = await snap.client.getOdds({
          sportKey: sportKey(e.sport, e.league),
          markets: Tracker.snapshotMarkets(e),
        });
        const hit = findOddsEvent(odds.events, e);
        if (hit) {
          json = JSON.stringify(linesForEvent(e.homeName, summarizeEvent(hit)));
        }
      } catch (err) {
        result.errors.push(`snapshot ${e.id}: ${(err as Error).message}`);
      }
      // One attempt per event, found or not.
      this.db
        .update(events)
        .set({ pregameOddsJson: json, pregameOddsAt: iso(now) })
        .where(eq(events.id, e.id))
        .run();
      if (json)
        recordLines(this.db, e.id, 'snapshot', JSON.parse(json), iso(now));
    }
  }

  /**
   * Resolve the close of open legs (any bet status: a dead parlay's later legs
   * still say whether the pick was sound). Legs with no close to fetch are
   * stamped right away; the rest share one snapshot per sport per window.
   * A game that started before its snapshot (early, or while we were down)
   * gets historical odds from just before its start when that is enabled,
   * else `missed`; live odds are never recorded as a close.
   */
  private async closingSnapshots(result: TickResult) {
    const clv = this.opts.clv;
    if (!clv?.enabled) return;
    const rows = this.db
      .select({ leg: legs, bet: bets })
      .from(legs)
      .innerJoin(bets, eq(bets.id, legs.betId))
      .where(and(isNull(legs.closeJson), eq(legs.status, 'open')))
      .all();
    if (!rows.length) return;
    const now = this.now();
    const at = iso(now);
    const { stamps, candidates } = this.closeCandidates(rows, now);
    const pending: CloseCandidate<CloseItem>[] = [];
    const late: CloseCandidate<CloseItem>[] = [];
    for (const c of candidates) {
      if (c.item.e.status !== 'pre' || now.getTime() >= c.start) {
        if (clv.historical) late.push(c);
        else
          stamps.push({
            leg: c.item.leg,
            close: unavailableClose('missed', at),
          });
      } else pending.push(c);
    }
    this.writeCloses(stamps, result);

    for (const w of closeWindows(pending, clv.windowMinutes * 60_000)) {
      if (now.getTime() < w.start - clv.leadMinutes * 60_000) continue;
      const id = `${w.key}|${w.start}`;
      const tried = this.clvTries.get(id);
      if (tried && now.getTime() < tried.at + clv.retrySeconds * 1000) continue;
      if (!clv.client.configured) continue;
      if (this.clvQuotaHeld(clv, now, at, result)) continue;
      let found: Awaited<ReturnType<OddsApiClient['getOdds']>>;
      try {
        found = await clv.client.getOdds({
          sportKey: w.key,
          markets: w.markets,
        });
      } catch (err) {
        const count = (tried?.count ?? 0) + 1;
        this.clvTries.set(id, { count, at: now.getTime() });
        result.errors.push(`clv ${w.key}: ${(err as Error).message}`);
        if (count >= 2) {
          this.clvTries.delete(id);
          this.writeCloses(
            w.items.map(({ leg }) => ({
              leg,
              close: unavailableClose('missed', at),
            })),
            result
          );
        }
        continue;
      }
      this.clvTries.delete(id);
      const { closes, started } = this.resolveCloses(
        w.items,
        found.events,
        at,
        now.getTime(),
        'snapshot',
        result
      );
      this.writeCloses(closes, result);
      // The API says these already began (early start): odds are live now.
      for (const { item, commence } of started) {
        if (clv.historical)
          late.push({
            key: w.key,
            start: commence,
            market: closeMarket(item.leg)!,
            item,
          });
        else
          this.writeCloses(
            [{ leg: item.leg, close: unavailableClose('missed', at) }],
            result
          );
      }
    }

    // Started without a close: odds from just before the start, then done.
    for (const w of closeWindows(late, clv.windowMinutes * 60_000)) {
      const missed = () =>
        this.writeCloses(
          w.items.map(({ leg }) => ({
            leg,
            close: unavailableClose('missed', at),
          })),
          result
        );
      const cost = clv.client.costOfHistorical(w.markets.length);
      if (
        !clv.client.configured ||
        this.clvQuotaHeld(clv, now, at, result, cost)
      ) {
        missed();
        continue;
      }
      try {
        const n = await this.historicalWindow(w, clv, result);
        if (n < w.items.length) missed(); // the rest; filled legs are kept
      } catch (err) {
        result.errors.push(
          `clv historical ${w.key}: ${(err as Error).message}`
        );
        missed();
      }
    }
  }

  /**
   * True when a call costing `cost` would leave less than the floor (a live
   * snapshot: when already below it). Below the floor is logged once a month.
   */
  private clvQuotaHeld(
    clv: NonNullable<TrackerOptions['clv']>,
    now: Date,
    at: string,
    result: TickResult,
    cost = 1
  ): boolean {
    const quota = clv.client.quota();
    if (quotaBelowFloor(quota, clv.quotaFloor, now)) {
      const month = at.slice(0, 7);
      if (this.clvFloorLogged !== month) {
        this.clvFloorLogged = month;
        result.errors.push(
          `clv: Odds API ${quota.remaining} left, below the floor of ${clv.quotaFloor}: no closing snapshots until the monthly reset`
        );
      }
      return true;
    }
    return quotaBelowFloor(
      { ...quota, remaining: (quota.remaining ?? Infinity) - (cost - 1) },
      clv.quotaFloor,
      now
    );
  }

  /**
   * Sort legs still without a close: stamps for those with nothing to fetch
   * (counted by reason in `skipped`), candidates (with their event and Odds
   * API key) for the rest. Unmatched legs wait until their day is over.
   */
  private closeCandidates(
    rows: { leg: LegRow; bet: BetRow }[],
    now: Date
  ): {
    stamps: { leg: LegRow; close: LegClose }[];
    candidates: CloseCandidate<CloseItem>[];
    skipped: Record<string, number>;
  } {
    const at = iso(now);
    const stamps: { leg: LegRow; close: LegClose }[] = [];
    const skipped: Record<string, number> = {};
    const stamp = (leg: LegRow, source: LegClose['source'], reason: string) => {
      skipped[reason] = (skipped[reason] ?? 0) + 1;
      stamps.push({ leg, close: unavailableClose(source, at) });
    };
    const candidates: CloseCandidate<CloseItem>[] = [];
    for (const { leg, bet } of rows) {
      const market = closeMarket(leg);
      if (bet.placedLive) stamp(leg, 'live', 'live');
      else if (!market) stamp(leg, 'unsupported', 'unsupported market');
      else if (leg.matchStatus !== 'matched' || !leg.eventId) {
        // Never matched: its day is over (36 h clears every US time zone).
        const end = new Date(`${leg.eventDate}T00:00:00Z`).getTime();
        if (now.getTime() > end + 36 * 3600_000)
          stamp(leg, 'missed', 'unmatched');
      } else {
        const siblings = this.db
          .select({ id: legs.id })
          .from(legs)
          .where(and(eq(legs.betId, bet.id), eq(legs.eventId, leg.eventId)))
          .all();
        const e = this.db
          .select()
          .from(events)
          .where(eq(events.id, leg.eventId))
          .get();
        let key: string | null = null;
        try {
          key = e ? sportKey(e.sport, e.league) : null;
        } catch {
          // A sport or league the API doesn't cover.
        }
        if (siblings.length > 1) stamp(leg, 'unsupported', 'same-game');
        else if (!e || !key) stamp(leg, 'unsupported', 'not on the Odds API');
        else
          candidates.push({
            key,
            start: new Date(e.startTime).getTime(),
            market,
            item: { leg, e, bet },
          });
      }
    }
    return { stamps, candidates, skipped };
  }

  /**
   * Closes for a window's legs from one Odds API response read as of
   * `asOf`. Events the API shows as already started at `asOf` are returned
   * in `started` instead: their odds are live, not a close.
   */
  private resolveCloses(
    items: CloseItem[],
    oddsEvents: OddsEvent[],
    at: string,
    asOf: number,
    via: NonNullable<LegClose['via']>,
    result: TickResult
  ): {
    closes: { leg: LegRow; close: LegClose }[];
    started: { item: CloseItem; commence: number }[];
  } {
    const closes: { leg: LegRow; close: LegClose }[] = [];
    const started: { item: CloseItem; commence: number }[] = [];
    for (const item of items) {
      const { leg, e, bet } = item;
      const hit = findOddsEvent(oddsEvents, e);
      if (hit && Date.parse(hit.commence_time) <= asOf) {
        started.push({ item, commence: Date.parse(hit.commence_time) });
        continue;
      }
      try {
        closes.push({
          leg,
          close: hit
            ? closeFromOdds(
                leg,
                e,
                summarizeEvent(hit),
                at,
                (l, odds) => this.interpolateClose(l, e, odds),
                { bookKey: bookKeyFor(bet.book), via }
              )
            : unavailableClose(
                via === 'historical' ? 'missed' : 'unsupported',
                at
              ),
        });
      } catch (err) {
        result.errors.push(`clv leg ${leg.id}: ${(err as Error).message}`);
        closes.push({ leg, close: unavailableClose('unsupported', at) });
      }
    }
    return { closes, started };
  }

  /**
   * One historical call for a window, as of `leadMinutes` before its
   * earliest start. Writes the closes it finds (replacing `missed` stamps)
   * and returns how many legs got a priced close.
   */
  private async historicalWindow(
    w: CloseWindow<CloseItem>,
    clv: NonNullable<TrackerOptions['clv']>,
    result: TickResult
  ): Promise<number> {
    const date = w.start - clv.leadMinutes * 60_000;
    const found = await clv.client.getHistoricalOdds({
      sportKey: w.key,
      markets: w.markets,
      date: new Date(date).toISOString(),
    });
    const { closes } = this.resolveCloses(
      w.items,
      found.events,
      new Date(found.timestamp ?? date).toISOString(),
      // Compare with the snapshot's own time: a game it lists as started
      // already has live odds.
      Date.parse(found.timestamp ?? new Date(date).toISOString()),
      'historical',
      result
    );
    const priced = closes.filter((c) => c.close.p != null);
    this.writeCloses(priced, result, { replaceMissed: true });
    return priced.length;
  }

  /**
   * Backfill closes for settled legs that have none (or only `missed`) from
   * historical odds: one call per sport per window, as of `leadMinutes`
   * before its earliest start. Paid Odds API plans only; on a plan without
   * historical odds nothing is written and `planAvailable` is false.
   * `dryRun` makes no calls and reports what it would cost.
   */
  async backfillCloses(
    opts: { dryRun?: boolean; maxCost?: number } = {}
  ): Promise<CloseBackfillReport> {
    const clv = this.opts.clv;
    if (!clv) throw new Error('CLV is not configured');
    const rows = this.db
      .select({ leg: legs, bet: bets })
      .from(legs)
      .innerJoin(bets, eq(bets.id, legs.betId))
      .where(
        and(
          ne(legs.status, 'open'),
          or(
            isNull(legs.closeJson),
            sql`json_extract(${legs.closeJson}, '$.source') = 'missed'`
          )
        )
      )
      .all();
    const now = this.now();
    const { candidates, skipped } = this.closeCandidates(rows, now);
    const windows = closeWindows(candidates, clv.windowMinutes * 60_000);
    const report: CloseBackfillReport = {
      missingClose: rows.length,
      eligible: candidates.length,
      skipped,
      windows: windows.length,
      estimatedCost: windows.reduce(
        (a, w) => a + clv.client.costOfHistorical(w.markets.length),
        0
      ),
      planAvailable: null,
      filled: 0,
      spent: 0,
      errors: [],
    };
    if (opts.dryRun || !windows.length) return report;
    if (!clv.client.configured) throw new Error('ODDS_API_KEY is not set');
    const result: TickResult = {
      polled: [],
      evaluatedEvents: [],
      changedBets: [],
      errors: report.errors,
    };
    for (const w of windows) {
      const cost = clv.client.costOfHistorical(w.markets.length);
      if (opts.maxCost != null && report.spent + cost > opts.maxCost) {
        report.errors.push(`stopped at maxCost ${opts.maxCost}`);
        break;
      }
      if (this.clvQuotaHeld(clv, now, iso(now), result, cost)) {
        report.errors.push(`stopped: quota floor ${clv.quotaFloor}`);
        break;
      }
      try {
        report.filled += await this.historicalWindow(w, clv, result);
        report.planAvailable = true;
        report.spent += cost;
      } catch (err) {
        if (err instanceof HistoricalUnavailableError) {
          report.planAvailable = false;
          report.errors.push(err.message);
          break;
        }
        report.errors.push(
          `${w.key} ${iso(new Date(w.start))}: ${(err as Error).message}`
        );
      }
    }
    return report;
  }

  /** A leg off the closing line, from the model fitted to the closing lines. */
  private interpolateClose(leg: LegRow, e: EventRow, odds: EventOdds) {
    const state = preState(e);
    const prior = ensureFit(
      e.sport,
      resolvePrior(
        e.sport,
        { snapshot: linesForEvent(e.homeName, odds) },
        this.opts.params
      ),
      this.opts.params,
      this.postseasonOf(e.stateJson ? JSON.parse(e.stateJson) : state)
    );
    return evaluateEvent(e.sport, state, prior, [selectionOf(leg)], {
      params: this.opts.params,
    })[0]!.outcome;
  }

  /**
   * Store closes, never over a stored one (another process, or an earlier
   * tick, may have written it); `replaceMissed` lets a priced close replace a
   * `missed` stamp (historical odds).
   */
  private writeCloses(
    closes: { leg: LegRow; close: LegClose }[],
    result: TickResult,
    opts: { replaceMissed?: boolean } = {}
  ) {
    if (!closes.length) return;
    this.db.transaction((tx) => {
      for (const { leg, close } of closes)
        tx.update(legs)
          .set({ closeJson: JSON.stringify(close) })
          .where(
            and(
              eq(legs.id, leg.id),
              opts.replaceMissed
                ? or(
                    isNull(legs.closeJson),
                    sql`json_extract(${legs.closeJson}, '$.source') = 'missed'`
                  )
                : isNull(legs.closeJson)
            )
          )
          .run();
    });
    result.changedBets.push(...new Set(closes.map((c) => c.leg.betId)));
  }

  private nextPoll(state: GameState): string | null {
    const now = this.now();
    const { liveSeconds, scheduledSeconds } = this.opts.polling;
    if (state.status === 'final') return null;
    if (state.status === 'in') return iso(addSeconds(now, liveSeconds));
    const start = new Date(state.startTime);
    const untilStart = (start.getTime() - now.getTime()) / 1000;
    if (untilStart <= liveSeconds) return iso(addSeconds(now, liveSeconds));
    return iso(addSeconds(now, Math.min(scheduledSeconds, untilStart)));
  }

  private async pollStates(due: EventRow[], result: TickResult) {
    const byProvider = new Map<string, EventRow[]>();
    for (const e of due) {
      const list = byProvider.get(e.provider) ?? [];
      list.push(e);
      byProvider.set(e.provider, list);
    }
    for (const [provider, list] of byProvider) {
      let states: Map<string, GameState>;
      try {
        states = await this.providers.forEventId(list[0]!.id).getStates(list);
      } catch (err) {
        // Back off one live interval and try again.
        result.errors.push(`${provider}: ${(err as Error).message}`);
        const retry = iso(
          addSeconds(this.now(), this.opts.polling.liveSeconds)
        );
        this.db
          .update(events)
          .set({ nextPollAt: retry })
          .where(
            inArray(
              events.id,
              list.map((e) => e.id)
            )
          )
          .run();
        continue;
      }
      for (const e of list) {
        const s = states.get(e.id);
        if (!s) {
          result.errors.push(`${e.id}: missing from ${provider} response`);
          continue;
        }
        this.db
          .update(events)
          .set({
            status: s.status,
            startTime: s.startTime,
            stateJson: JSON.stringify(s),
            stateUpdatedAt: s.fetchedAt,
            nextPollAt: this.nextPoll(s),
            updatedAt: iso(this.now()),
          })
          .where(eq(events.id, e.id))
          .run();
        result.polled.push(e.id);
        const change: StateChange = {
          event: e,
          prev: e.stateJson ? (JSON.parse(e.stateJson) as GameState) : null,
          next: s,
        };
        this.emit('state', change);
      }
    }
  }

  private postseasonOf(state: GameState): boolean {
    return (
      !!state.postseason ||
      (state.situation?.kind === 'hockey' && state.situation.postseason)
    );
  }

  /**
   * One bet's prior on an event: the event's market lines (shared by every
   * bet) plus that bet's own entered prices (pregame bets only), fitted.
   * With `asOf`, market lines come from the history as they stood then
   * (placement); otherwise the event's current lines, which stop updating
   * once it starts, so a started game's prior is effectively frozen.
   */
  private betPrior(
    e: EventRow,
    bet: BetRow,
    betLegs: LegRow[],
    state: GameState,
    asOf?: string
  ): Prior {
    const parse = <T>(json: string | null) =>
      json ? (JSON.parse(json) as T) : null;
    const espnLines =
      (asOf ? linesAsOf<PregameLines>(this.db, e.id, 'espn', asOf) : null) ??
      parse<PregameLines>(e.providerLinesJson);
    const snapshot =
      (asOf ? linesAsOf<LinesInput>(this.db, e.id, 'snapshot', asOf) : null) ??
      parse<LinesInput>(e.pregameOddsJson);
    const entered: EnteredLeg[] = bet.placedLive
      ? []
      : betLegs
          .filter((l) => !isProp(l))
          .map((l) => ({
            market: l.market,
            selectionKind: l.selectionKind,
            side: l.side,
            line: l.line,
            price: l.priceAmerican,
          }));
    const prior = resolvePrior(
      e.sport,
      { espnLines, snapshot, entered },
      this.opts.params
    );
    return ensureFit(
      e.sport,
      prior,
      this.opts.params,
      this.postseasonOf(state)
    );
  }

  /**
   * Per leg, the log-odds shift that makes the pregame model match the
   * market's fair price for that exact line (from this bet's prior); legs
   * without a market price get none.
   */
  private anchorsFor(e: EventRow, prior: Prior, ls: LegRow[]) {
    const sels = ls.map(selectionOf);
    const pre = evaluateEvent(e.sport, preState(e), prior, sels, {
      params: this.opts.params,
    });
    return ls.map((_, i) => {
      const m = marketFor(prior, sels[i]!);
      return {
        shift: m ? anchorShift(pre[i]!.outcome, m.p) : null,
        source: m ? `${m.source}: ${(m.p * 100).toFixed(1)}%` : 'none',
      };
    });
  }

  /**
   * Placement values for `targets` (any status): live bets use their own
   * de-vigged price; pregame bets use their prior with market lines as of
   * placement (placedAt, else when the bet was logged), anchored, evaluated
   * pregame. Same-game groups also get their joint placement.
   */
  private placementFor(
    e: EventRow,
    targets: LegRow[],
    allLegs: LegRow[],
    state: GameState
  ) {
    const out = new Map<number, { win: number; push: number; json: string }>();
    const joints: { betId: number; outcomes: StoredJoint[] }[] = [];
    // Player props, pregame or live: their own price, de-vigged.
    for (const l of targets.filter(isProp)) {
      const { p, prior } = propPlacement(l, this.props);
      out.set(l.id, {
        win: p,
        push: 0,
        json: JSON.stringify({ source: prior.source, detail: prior.detail }),
      });
    }
    const byBet = groupBy(
      targets.filter((l) => !isProp(l)),
      (l) => l.betId
    );
    for (const [betId, ls] of byBet) {
      const bet = this.db.select().from(bets).where(eq(bets.id, betId)).get();
      if (!bet) continue;
      if (bet.placedLive) {
        for (const l of ls) {
          const hold = l.market === 'moneyline3way' ? 0.06 : undefined;
          out.set(l.id, {
            win: devigSingle(l.priceAmerican, hold),
            push: 0,
            json: JSON.stringify({
              source: 'entered (live bet)',
              detail: `${fmtPrice(l.priceAmerican)} de-vigged`,
            }),
          });
        }
        continue;
      }
      const asOf = bet.placedAt ?? bet.createdAt;
      const betLegs = allLegs.filter((l) => l.betId === betId);
      const prior = this.betPrior(e, bet, betLegs, state, asOf);
      const anchors = this.anchorsFor(e, prior, ls);
      const evals = evaluateEvent(
        e.sport,
        preState(e),
        prior,
        ls.map(selectionOf),
        {
          params: this.opts.params,
          anchors: anchors.map((a) => a.shift),
        }
      );
      ls.forEach((l, i) =>
        out.set(l.id, {
          win: evals[i]!.outcome.win,
          push: evals[i]!.outcome.push,
          json: JSON.stringify({
            source: prior.source,
            detail: prior.detail,
            anchor: anchors[i]!.source,
            linesAsOf: asOf,
          }),
        })
      );
      // No joint model covers a player prop on the same game.
      if (betLegs.length > 1 && !betLegs.some(isProp)) {
        const j = jointOutcomes(
          e.sport,
          preState(e),
          prior,
          betLegs.map(selectionOf),
          this.opts.params
        );
        if (j) joints.push({ betId, outcomes: toStored(betLegs, j) });
      }
    }
    return { legs: out, joints };
  }

  /**
   * Re-evaluate every event with an open leg from stored state, without
   * polling. Run at startup so model changes apply immediately instead of at
   * each event's next poll.
   */
  reevaluateAll(): TickResult {
    const result: TickResult = {
      polled: [],
      evaluatedEvents: [],
      changedBets: [],
      errors: [],
    };
    const ids = this.db
      .selectDistinct({ id: legs.eventId })
      .from(legs)
      .where(and(eq(legs.status, 'open'), eq(legs.matchStatus, 'matched')))
      .all()
      .map((r) => r.id)
      .filter((id): id is string => !!id);
    for (const id of ids) this.evaluate(id, result);
    const seriesIds = this.db
      .selectDistinct({ id: legs.seriesId })
      .from(legs)
      .where(and(eq(legs.status, 'open'), eq(legs.matchStatus, 'matched')))
      .all()
      .map((r) => r.id)
      .filter((id): id is string => !!id);
    for (const id of seriesIds) this.evaluateSeriesLegs(id, result);
    if (result.evaluatedEvents.length) this.emit('change', result);
    return result;
  }

  /**
   * Rebuild one bet from scratch: priors from its own prices, placement
   * values, anchors, same-game joints, and settlement of finished games
   * (bet status and settle time re-derived from its legs). For corrected
   * prices or edited legs.
   */
  recomputeBet(betId: number): TickResult {
    const result: TickResult = {
      polled: [],
      evaluatedEvents: [],
      changedBets: [],
      errors: [],
    };
    const bet = this.db.select().from(bets).where(eq(bets.id, betId)).get();
    if (!bet) throw new Error(`Bet ${betId} not found`);
    const betLegs = this.db
      .select()
      .from(legs)
      .where(eq(legs.betId, betId))
      .all();
    const eventIds = [
      ...new Set(betLegs.map((l) => l.eventId).filter((x): x is string => !!x)),
    ];
    const seriesIds = [
      ...new Set(
        betLegs.map((l) => l.seriesId).filter((x): x is string => !!x)
      ),
    ];
    const finals = new Set([
      ...(eventIds.length
        ? this.db
            .select({ id: events.id })
            .from(events)
            .where(
              and(inArray(events.id, eventIds), eq(events.status, 'final'))
            )
            .all()
            .map((r) => r.id)
        : []),
      ...(seriesIds.length
        ? this.db
            .select({ id: series.id })
            .from(series)
            .where(
              and(inArray(series.id, seriesIds), eq(series.status, 'final'))
            )
            .all()
            .map((r) => r.id)
        : []),
    ]);
    this.db.transaction((tx) => {
      // Legs settled by hand (props without a box score) keep their result.
      for (const l of betLegs.filter((x) => x.model !== 'manual')) {
        tx.update(legs)
          .set({
            pWinPlacement: null,
            pPushPlacement: null,
            placementJson: null,
            anchorLogit: null,
            anchorSource: null,
            priorJson: null,
            priorSource: null,
            evaluatedAt: null,
            // Finished games re-settle from their final state.
            ...((l.eventId && finals.has(l.eventId)) ||
            (l.seriesId && finals.has(l.seriesId))
              ? { status: 'open' as const }
              : {}),
          })
          .where(eq(legs.id, l.id))
          .run();
      }
      tx.update(bets)
        .set({
          jointJson: null,
          jointPlacementJson: null,
          status: 'open',
          settledAt: null,
        })
        .where(eq(bets.id, betId))
        .run();
    });
    for (const id of eventIds) this.evaluate(id, result);
    for (const id of seriesIds) this.evaluateSeriesLegs(id, result);
    // Legs kept from a hand settle aren't re-evaluated: derive the bet here.
    const after = this.db
      .select()
      .from(legs)
      .where(eq(legs.betId, betId))
      .all();
    const status = betStatus(after);
    const now = this.db.select().from(bets).where(eq(bets.id, betId)).get()!;
    if (now.status === 'open' && status !== 'open')
      this.db
        .update(bets)
        .set({
          status,
          settledAt: this.settledAtFor(this.db, betId) ?? iso(this.now()),
        })
        .where(eq(bets.id, betId))
        .run();
    result.changedBets.push(betId);
    this.emit('change', result);
    return result;
  }

  /** Re-evaluate every open leg on an event (any bet), settle, snapshot. */
  evaluate(eventId: string, result: TickResult) {
    const e = this.db.select().from(events).where(eq(events.id, eventId)).get();
    if (!e) return;
    const allLegs = this.db
      .select()
      .from(legs)
      .where(eq(legs.eventId, eventId))
      .all();
    const open = allLegs.filter((l) => l.status === 'open');
    if (open.length === 0) return;
    const gameOpen = open.filter((l) => !isProp(l));
    const state = e.stateJson
      ? (JSON.parse(e.stateJson) as GameState)
      : preState(e);
    const now = iso(this.now());

    // Each bet's legs are evaluated with that bet's own prior.
    const updates: LegUpdate[] = [];
    const jointsNow: { betId: number; outcomes: StoredJoint[] }[] = [];
    try {
      for (const [betId, ls] of groupBy(gameOpen, (l) => l.betId)) {
        const bet = this.db.select().from(bets).where(eq(bets.id, betId)).get();
        if (!bet) continue;
        const betLegs = allLegs.filter((l) => l.betId === betId);
        const prior = this.betPrior(e, bet, betLegs, state);
        const anchors = this.anchorsFor(e, prior, ls);
        const evals = evaluateEvent(
          e.sport,
          state,
          prior,
          ls.map(selectionOf),
          {
            params: this.opts.params,
            anchors: anchors.map((a) => a.shift),
          }
        );
        ls.forEach((leg, i) =>
          updates.push({ leg, ev: evals[i]!, anchor: anchors[i]!, prior })
        );
        // Same-game groups with an open player prop have no joint model.
        if (
          ls.length > 1 &&
          state.status !== 'final' &&
          !betLegs.some((l) => isProp(l) && l.status === 'open')
        ) {
          const j = jointOutcomes(
            e.sport,
            state,
            prior,
            ls.map(selectionOf),
            this.opts.params
          );
          if (j) jointsNow.push({ betId, outcomes: toStored(ls, j) });
        }
      }
      const stats = e.playerStatsJson
        ? (JSON.parse(e.playerStatsJson) as PlayerStats)
        : null;
      for (const leg of open.filter(isProp)) {
        const { p, prior } = propPlacement(leg, this.props);
        const team =
          leg.side === 'home'
            ? e.homeName
            : leg.side === 'away'
              ? e.awayName
              : null;
        const ev = evaluateProp(
          {
            propType: leg.propType!,
            player: leg.playerName!,
            team,
            side: leg.side,
            kind: leg.selectionKind,
            line: leg.line,
          },
          state,
          stats,
          p,
          this.props
        );
        updates.push({ leg, ev, anchor: { shift: null, source: null }, prior });
      }
    } catch (err) {
      result.errors.push(`evaluate ${eventId}: ${(err as Error).message}`);
      return;
    }

    const needPlacement = open.filter((l) => l.pWinPlacement == null);
    let placement: Placement | null = null;
    try {
      placement = needPlacement.length
        ? this.placementFor(e, needPlacement, allLegs, state)
        : null;
    } catch (err) {
      result.errors.push(`placement ${eventId}: ${(err as Error).message}`);
    }

    const affectedBets = this.applyUpdates(
      e.id,
      updates,
      jointsNow,
      placement,
      { status: state.status, fractionRemaining: state.fractionRemaining },
      now
    );
    result.evaluatedEvents.push(eventId);
    result.changedBets.push(...affectedBets);
  }

  /**
   * Write leg evaluations (joints keyed by event or series id), stamp
   * placement values, snapshot or settle each leg, and settle bets whose
   * legs are all decided. Returns the bets touched.
   */
  private applyUpdates(
    key: string,
    updates: LegUpdate[],
    jointsNow: { betId: number; outcomes: StoredJoint[] }[],
    placement: Placement | null,
    snap: { status: GameState['status']; fractionRemaining: number },
    now: string
  ): Set<number> {
    const affectedBets = new Set<number>();
    const merge = (json: string | null, outcomes: StoredJoint[]) =>
      JSON.stringify({ ...(json ? JSON.parse(json) : {}), [key]: outcomes });
    this.db.transaction((tx) => {
      for (const j of jointsNow) {
        const bet = tx.select().from(bets).where(eq(bets.id, j.betId)).get();
        if (bet)
          tx.update(bets)
            .set({ jointJson: merge(bet.jointJson, j.outcomes) })
            .where(eq(bets.id, j.betId))
            .run();
      }
      for (const j of placement?.joints ?? []) {
        const bet = tx.select().from(bets).where(eq(bets.id, j.betId)).get();
        if (
          bet &&
          !(bet.jointPlacementJson && key in JSON.parse(bet.jointPlacementJson))
        ) {
          tx.update(bets)
            .set({
              jointPlacementJson: merge(bet.jointPlacementJson, j.outcomes),
            })
            .where(eq(bets.id, j.betId))
            .run();
        }
      }
      for (const { leg, ev, anchor, prior } of updates) {
        const placed = placement?.legs.get(leg.id);
        tx.update(legs)
          .set({
            pWin: ev.outcome.win,
            pPush: ev.outcome.push,
            model: ev.model,
            modelInputsJson: JSON.stringify(ev.inputs),
            evaluatedAt: now,
            status: ev.status,
            anchorLogit: anchor.shift,
            anchorSource: anchor.source,
            priorSource: prior.source,
            priorJson: JSON.stringify(prior),
            ...(placed
              ? {
                  pWinPlacement: placed.win,
                  pPushPlacement: placed.push,
                  placementJson: placed.json,
                }
              : {}),
            updatedAt: now,
          })
          .where(eq(legs.id, leg.id))
          .run();

        if (ev.status === 'open') {
          this.maybeSnapshot(tx, leg, snap, ev.outcome.win, now);
        } else {
          // Settled: stamp the outcome on this leg's calibration snapshots.
          const outcome =
            ev.status === 'won' ? 1 : ev.status === 'lost' ? 0 : null;
          tx.update(predictionSnapshots)
            .set({ outcome })
            .where(eq(predictionSnapshots.legId, leg.id))
            .run();
        }
        affectedBets.add(leg.betId);
      }

      for (const betId of affectedBets) {
        const bet = tx.select().from(bets).where(eq(bets.id, betId)).get();
        if (!bet || bet.status !== 'open') continue;
        const status = betStatus(
          tx
            .select({ status: legs.status })
            .from(legs)
            .where(eq(legs.betId, betId))
            .all()
        );
        if (status !== 'open') {
          tx.update(bets)
            .set({
              status,
              settledAt: this.settledAtFor(tx, betId),
              updatedAt: now,
            })
            .where(eq(bets.id, betId))
            .run();
        }
      }
    });
    return affectedBets;
  }

  // --- Series (series markets) -------------------------------------------------

  /** Series with an open leg whose next poll is due (or never fetched). */
  private dueSeries(): SeriesRow[] {
    const now = iso(this.now());
    return this.db
      .selectDistinct({ s: series })
      .from(series)
      .innerJoin(legs, eq(legs.seriesId, series.id))
      .where(
        and(
          eq(legs.status, 'open'),
          or(
            isNull(series.stateJson),
            and(
              ne(series.status, 'final'),
              or(isNull(series.nextPollAt), lte(series.nextPollAt, now))
            )
          )
        )
      )
      .all()
      .map((r) => r.s);
  }

  /** Live game: poll live; else up to the next game's start. */
  private nextSeriesPoll(s: SeriesState): string | null {
    if (s.status === 'final') return null;
    const { liveSeconds, scheduledSeconds } = this.opts.polling;
    const now = this.now();
    if (s.games.some((g) => g.status === 'in'))
      return iso(addSeconds(now, liveSeconds));
    const next = s.games.find((g) => g.status === 'pre');
    const until = next
      ? (new Date(next.startTime).getTime() - now.getTime()) / 1000
      : scheduledSeconds;
    return iso(
      addSeconds(now, Math.max(liveSeconds, Math.min(scheduledSeconds, until)))
    );
  }

  /**
   * Fetch due series: state, ESPN's live win probability for a game in
   * progress, and the next (or current) game's line, which updates the
   * per-game strength (kept once no game has a line).
   */
  private async pollSeries(result: TickResult): Promise<string[]> {
    const polled: string[] = [];
    for (const row of this.dueSeries()) {
      let got: Awaited<ReturnType<Providers['series']['getState']>>;
      try {
        got = await this.providers.series.getState(row);
      } catch (err) {
        result.errors.push(`series ${row.id}: ${(err as Error).message}`);
        this.db
          .update(series)
          .set({
            nextPollAt: iso(
              addSeconds(this.now(), this.opts.polling.liveSeconds)
            ),
          })
          .where(eq(series.id, row.id))
          .run();
        continue;
      }
      if (!got) {
        result.errors.push(`series ${row.id}: no games found`);
        this.db
          .update(series)
          .set({
            nextPollAt: iso(
              addSeconds(this.now(), this.opts.polling.scheduledSeconds)
            ),
          })
          .where(eq(series.id, row.id))
          .run();
        continue;
      }
      const { state, line } = got;
      const prev = row.strengthJson
        ? (JSON.parse(row.strengthJson) as SeriesStrength)
        : null;
      let strength = prev;
      if (line) {
        const g = state.games.find((x) => x.id === line.gameId)!;
        const pHome =
          g.homeTeamId === state.home.id ? line.pHost : 1 - line.pHost;
        const host = g.homeTeamId === state.home.id ? state.home : state.away;
        strength = {
          source: 'espn_lines',
          logit: strengthFromGame(state, line.number, pHome),
          games: {
            ...(prev?.source === 'espn_lines' ? prev.games : {}),
            [line.gameId]: pHome,
          },
          detail: `Game ${line.number} line (ESPN): ${host.abbr ?? host.name} host ${(line.pHost * 100).toFixed(1)}% de-vigged`,
        };
      }
      const now = iso(this.now());
      this.db
        .update(series)
        .set({
          status: state.status,
          title: state.title ?? row.title,
          bestOf: state.bestOf,
          stateJson: JSON.stringify(state),
          stateUpdatedAt: now,
          nextPollAt: this.nextSeriesPoll(state),
          ...(line
            ? { strengthJson: JSON.stringify(strength), strengthAt: now }
            : {}),
          updatedAt: now,
        })
        .where(eq(series.id, row.id))
        .run();
      polled.push(row.id);
      result.polled.push(row.id);
    }
    return polled;
  }

  /**
   * A bet's per-game strength for a series: ESPN lines when any game had
   * one; else its own entered series price (pregame bets), fitted at the
   * series state when it was placed; else neutral.
   */
  private seriesStrengthFor(
    row: SeriesRow,
    state: SeriesState,
    bet: BetRow,
    betLegs: LegRow[]
  ): SeriesStrength {
    if (row.strengthJson) return JSON.parse(row.strengthJson) as SeriesStrength;
    const own = bet.placedLive
      ? undefined
      : betLegs.find((l) => l.seriesId === row.id && l.side);
    if (own) {
      const asOf = bet.placedAt ?? bet.createdAt;
      const p = devigSingle(own.priceAmerican);
      return {
        source: 'entered_odds',
        logit: strengthForPrice(stateAsOf(state, asOf), selectionOf(own), p),
        detail: `entered ${fmtPrice(own.priceAmerican)} (${(p * 100).toFixed(1)}% de-vigged) at the series state when placed`,
      };
    }
    return { source: 'neutral', logit: 0, detail: 'neutral: no price' };
  }

  /** Re-evaluate every open leg on a series, settle, snapshot. */
  evaluateSeriesLegs(seriesId: string, result: TickResult) {
    const row = this.db
      .select()
      .from(series)
      .where(eq(series.id, seriesId))
      .get();
    if (!row?.stateJson) return;
    const state = JSON.parse(row.stateJson) as SeriesState;
    const allLegs = this.db
      .select()
      .from(legs)
      .where(eq(legs.seriesId, seriesId))
      .all();
    const open = allLegs.filter((l) => l.status === 'open');
    if (!open.length) return;
    const now = iso(this.now());
    const updates: LegUpdate[] = [];
    const jointsNow: { betId: number; outcomes: StoredJoint[] }[] = [];
    const placement: Placement = { legs: new Map(), joints: [] };
    try {
      for (const [betId, ls] of groupBy(open, (l) => l.betId)) {
        const bet = this.db.select().from(bets).where(eq(bets.id, betId)).get();
        if (!bet) continue;
        const betLegs = this.db
          .select()
          .from(legs)
          .where(eq(legs.betId, betId))
          .all();
        const strength = this.seriesStrengthFor(row, state, bet, betLegs);
        const sels = ls.map(selectionOf);
        const evals = evaluateSeries(state, strength, sels);
        ls.forEach((leg, i) =>
          updates.push({
            leg,
            ev: evals[i]!,
            anchor: { shift: null, source: null },
            prior: strength,
          })
        );
        if (ls.length > 1 && state.status !== 'final')
          jointsNow.push({
            betId,
            outcomes: toStored(
              ls,
              seriesJoint(seriesPmf(state, strength), sels)
            ),
          });
        // Placement: live bets their own price; others the model at the
        // series state when placed.
        const need = ls.filter((l) => l.pWinPlacement == null);
        if (!need.length) continue;
        const asOf = bet.placedAt ?? bet.createdAt;
        if (bet.placedLive) {
          for (const l of need)
            placement.legs.set(l.id, {
              win: devigSingle(l.priceAmerican),
              push: 0,
              json: JSON.stringify({
                source: 'entered (live bet)',
                detail: `${fmtPrice(l.priceAmerican)} de-vigged`,
              }),
            });
          continue;
        }
        const then = stateAsOf(state, asOf);
        const pre = evaluateSeries(then, strength, need.map(selectionOf));
        need.forEach((l, i) =>
          placement.legs.set(l.id, {
            win: pre[i]!.outcome.win,
            push: pre[i]!.outcome.push,
            json: JSON.stringify({
              source: strength.source,
              detail: strength.detail,
              seriesAsOf: `${then.away.abbr ?? then.away.name} ${then.away.wins}-${then.home.wins} ${then.home.abbr ?? then.home.name}`,
              placedAt: asOf,
            }),
          })
        );
        if (ls.length > 1)
          placement.joints.push({
            betId,
            outcomes: toStored(
              ls,
              seriesJoint(seriesPmf(then, strength), sels)
            ),
          });
      }
    } catch (err) {
      result.errors.push(`evaluate ${seriesId}: ${(err as Error).message}`);
      return;
    }
    const played = state.home.wins + state.away.wins;
    const affected = this.applyUpdates(
      seriesId,
      updates,
      jointsNow,
      placement,
      {
        status: state.status,
        fractionRemaining:
          state.status === 'final' ? 0 : Math.max(0, 1 - played / state.bestOf),
      },
      now
    );
    result.evaluatedEvents.push(seriesId);
    result.changedBets.push(...affected);
  }

  /** Series with open legs never evaluated (new bets). */
  private unevaluatedSeriesIds(): string[] {
    return this.db
      .selectDistinct({ id: legs.seriesId })
      .from(legs)
      .where(
        and(
          eq(legs.status, 'open'),
          eq(legs.matchStatus, 'matched'),
          isNull(legs.evaluatedAt)
        )
      )
      .all()
      .map((r) => r.id)
      .filter((id): id is string => !!id);
  }

  /**
   * When a bet settled from its legs: its games' final times (betSettledAt),
   * never when settlement ran.
   */
  private settledAtFor(tx: Db | Tx, betId: number): string | null {
    const ls = tx
      .select({
        status: legs.status,
        eventId: legs.eventId,
        seriesId: legs.seriesId,
      })
      .from(legs)
      .where(eq(legs.betId, betId))
      .all();
    const sids = [
      ...new Set(ls.map((l) => l.seriesId).filter((x): x is string => !!x)),
    ];
    // A series ends with its deciding game.
    const seriesFinal = new Map(
      (sids.length
        ? tx
            .select()
            .from(series)
            .where(and(inArray(series.id, sids), eq(series.status, 'final')))
            .all()
        : []
      ).flatMap((s) => {
        const st = s.stateJson
          ? (JSON.parse(s.stateJson) as SeriesState)
          : null;
        if (!st?.decidedAt) return [];
        return [
          [
            s.id,
            eventFinalAt(
              s.sport,
              st.decidedAt,
              { status: 'final', cancelled: false, fetchedAt: st.fetchedAt },
              this.now()
            ),
          ] as const,
        ];
      })
    );
    const ids = [
      ...new Set(ls.map((l) => l.eventId).filter((x): x is string => !!x)),
    ];
    const finalAt = new Map(
      (ids.length
        ? tx
            .select()
            .from(events)
            .where(and(inArray(events.id, ids), eq(events.status, 'final')))
            .all()
        : []
      ).map((e) => [
        e.id,
        eventFinalAt(
          e.sport,
          e.startTime,
          e.stateJson ? (JSON.parse(e.stateJson) as GameState) : null,
          this.now()
        ),
      ])
    );
    return betSettledAt(
      ls.map((l) => ({
        status: l.status,
        finalAt:
          (l.eventId && finalAt.get(l.eventId)) ||
          (l.seriesId && seriesFinal.get(l.seriesId)) ||
          null,
      }))
    );
  }

  /**
   * Re-derive settledAt for every bet settled from final scores (bets whose
   * stored result differs from their legs' were settled by hand and are
   * left alone). Final events without a provider end time are re-fetched
   * first, in case the provider has one now. Never moves a settle time
   * later. Returns the changes.
   */
  async backfillSettledAt(
    opts: { dryRun?: boolean } = {}
  ): Promise<{ id: number; from: string | null; to: string }[]> {
    const settled = this.db
      .select()
      .from(bets)
      .where(ne(bets.status, 'open'))
      .all();
    const betLegs = settled.length
      ? this.db
          .select()
          .from(legs)
          .where(
            inArray(
              legs.betId,
              settled.map((b) => b.id)
            )
          )
          .all()
      : [];
    const ids = [
      ...new Set(betLegs.map((l) => l.eventId).filter((x): x is string => !!x)),
    ];
    const stale = (
      ids.length
        ? this.db
            .select()
            .from(events)
            .where(and(inArray(events.id, ids), eq(events.status, 'final')))
            .all()
        : []
    ).filter(
      (e) => !e.stateJson || !(JSON.parse(e.stateJson) as GameState).endTime
    );
    if (!opts.dryRun) {
      // Only take a re-fetched state that adds an end time: replacing the
      // rest would lose when the game was first seen final.
      for (const [, list] of groupBy(stale, (e) => e.provider)) {
        const states = await this.providers
          .forEventId(list[0]!.id)
          .getStates(list);
        for (const e of list) {
          const s = states.get(e.id);
          if (s?.status === 'final' && s.endTime)
            this.db
              .update(events)
              .set({ stateJson: JSON.stringify(s) })
              .where(eq(events.id, e.id))
              .run();
        }
      }
    }
    const changes: { id: number; from: string | null; to: string }[] = [];
    for (const bet of settled) {
      const ls = betLegs.filter((l) => l.betId === bet.id);
      if (betStatus(ls) !== bet.status) continue;
      let to = this.settledAtFor(this.db, bet.id);
      // The old stamp (when settlement ran) is also a bound: never later.
      if (to && bet.settledAt && bet.settledAt < to) to = bet.settledAt;
      if (!to || to === bet.settledAt) continue;
      changes.push({ id: bet.id, from: bet.settledAt, to });
      if (!opts.dryRun)
        this.db
          .update(bets)
          .set({ settledAt: to })
          .where(eq(bets.id, bet.id))
          .run();
    }
    if (changes.length && !opts.dryRun)
      this.emit('change', {
        polled: [],
        evaluatedEvents: [],
        changedBets: changes.map((c) => c.id),
        errors: [],
      } satisfies TickResult);
    return changes;
  }

  private maybeSnapshot(
    tx: Tx,
    leg: LegRow,
    state: { status: GameState['status']; fractionRemaining: number },
    p: number,
    now: string
  ) {
    const last = tx
      .select({ takenAt: predictionSnapshots.takenAt })
      .from(predictionSnapshots)
      .where(eq(predictionSnapshots.legId, leg.id))
      .orderBy(desc(predictionSnapshots.takenAt))
      .limit(1)
      .get();
    const every = (this.opts.snapshotEveryMinutes ?? 5) * 60_000;
    // Pregame: one snapshot. Live: at most one per interval.
    if (
      last &&
      (state.status === 'pre' ||
        new Date(now).getTime() - new Date(last.takenAt).getTime() < every)
    )
      return;
    tx.insert(predictionSnapshots)
      .values({
        betId: leg.betId,
        legId: leg.id,
        sport: leg.sport,
        market: leg.market,
        takenAt: now,
        gameStatus: state.status,
        fractionRemaining: state.fractionRemaining,
        probability: p,
      })
      .run();
  }
}
