import { EventEmitter } from 'node:events';
import { and, desc, eq, inArray, isNull, lte, ne, or } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import {
  bets,
  events,
  legs,
  predictionSnapshots,
  type EventRow,
  type BetRow,
  type LegRow,
} from '../db/schema.js';
import { betStatus } from '../domain/value.js';
import type { Providers } from '../gamestate/registry.js';
import type { GameState, PregameLines } from '../gamestate/types.js';
import { nameScore } from '../matching/match.js';
import { matchLegs } from '../matching/service.js';
import { linesAsOf, recordLines } from './lines.js';
import {
  filterEvents,
  linesFromOdds,
  summarizeEvent,
} from '../odds/consensus.js';
import {
  sportKey,
  type OddsApiClient,
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
import type { ModelSelection } from '../models/types.js';
import { devigSingle } from '../odds/math.js';

export interface TrackerOptions {
  params: ModelParams;
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

const selectionOf = (l: LegRow): ModelSelection => ({
  market: l.market,
  kind: l.selectionKind,
  side: l.side,
  line: l.line,
});

/**
 * Polls game state for events with open legs, keeps priors and leg
 * probabilities current, settles finished legs and bets, and logs
 * calibration snapshots. Emits 'change' with a TickResult when anything moved.
 */
export class Tracker extends EventEmitter {
  private readonly now: () => Date;
  private lastRematch = 0;
  private readonly matchAttempted = new Set<number>();
  private running = false;

  constructor(
    private readonly db: Db,
    private readonly providers: Providers,
    private readonly opts: TrackerOptions
  ) {
    super();
    this.now = opts.now ?? (() => new Date());
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
      await this.refreshLines(due, result);
      await this.pregameSnapshots(due, result);
      await this.pollStates(due, result);
      for (const id of new Set([
        ...result.polled,
        ...this.unevaluatedEventIds(),
      ])) {
        this.evaluate(id, result);
      }
    } finally {
      this.running = false;
    }
    if (result.changedBets.length || result.evaluatedEvents.length)
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
   * Events with an open leg whose next poll is due, plus any never fetched
   * (a leg matched to an already-final game still needs its final state).
   * Legs of settled bets (e.g. a dead parlay) keep polling until their game
   * ends so their calibration snapshots get an outcome.
   */
  private dueEvents(): EventRow[] {
    const now = iso(this.now());
    return this.db
      .selectDistinct({ e: events })
      .from(events)
      .innerJoin(legs, eq(legs.eventId, events.id))
      .where(
        and(
          eq(legs.status, 'open'),
          or(
            isNull(events.stateJson),
            and(
              ne(events.status, 'final'),
              or(isNull(events.nextPollAt), lte(events.nextPollAt, now))
            )
          )
        )
      )
      .all()
      .map((r) => r.e);
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
        const hit = filterEvents(
          odds.events,
          `${e.awayName} @ ${e.homeName}`
        ).find(
          (o) =>
            Math.abs(
              new Date(o.commence_time).getTime() -
                new Date(e.startTime).getTime()
            ) <
            12 * 3600_000
        );
        if (hit) {
          const lines = linesFromOdds(summarizeEvent(hit));
          // Fights have no home/away: align the API's sides with ours.
          const swapped =
            nameScore(e.homeName, [hit.home_team]) <
            nameScore(e.homeName, [hit.away_team]);
          json = JSON.stringify(
            swapped
              ? {
                  ...lines,
                  homeMoneyline: lines.awayMoneyline,
                  awayMoneyline: lines.homeMoneyline,
                  spreadHome:
                    lines.spreadHome == null ? null : -lines.spreadHome,
                }
              : lines
          );
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
      : betLegs.map((l) => ({
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
    const byBet = groupBy(targets, (l) => l.betId);
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
      if (betLegs.length > 1) {
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
    if (result.evaluatedEvents.length) this.emit('change', result);
    return result;
  }

  /**
   * Rebuild one bet from scratch: priors from its own prices, placement
   * values, anchors, same-game joints, and settlement of finished games
   * (bet status re-derived from its legs; the settle time is kept when the
   * result doesn't change). For corrected prices or edited legs.
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
    const finals = new Set(
      eventIds.length
        ? this.db
            .select({ id: events.id })
            .from(events)
            .where(
              and(inArray(events.id, eventIds), eq(events.status, 'final'))
            )
            .all()
            .map((r) => r.id)
        : []
    );
    this.db.transaction((tx) => {
      for (const l of betLegs) {
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
            ...(l.eventId && finals.has(l.eventId)
              ? { status: 'open' as const }
              : {}),
          })
          .where(eq(legs.id, l.id))
          .run();
      }
      tx.update(bets)
        .set({ jointJson: null, jointPlacementJson: null, status: 'open' })
        .where(eq(bets.id, betId))
        .run();
    });
    for (const id of eventIds) this.evaluate(id, result);
    const after = this.db.select().from(bets).where(eq(bets.id, betId)).get()!;
    if (after.status === bet.status) {
      // Same result: keep when it originally settled.
      this.db
        .update(bets)
        .set({ settledAt: bet.settledAt })
        .where(eq(bets.id, betId))
        .run();
    }
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
    const state = e.stateJson
      ? (JSON.parse(e.stateJson) as GameState)
      : preState(e);
    const now = iso(this.now());

    // Each bet's legs are evaluated with that bet's own prior.
    type LegUpdate = {
      leg: LegRow;
      ev: ReturnType<typeof evaluateEvent>[number];
      anchor: { shift: number | null; source: string | null };
      prior: Prior;
    };
    const updates: LegUpdate[] = [];
    const jointsNow: { betId: number; outcomes: StoredJoint[] }[] = [];
    try {
      for (const [betId, ls] of groupBy(open, (l) => l.betId)) {
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
        if (ls.length > 1 && state.status !== 'final') {
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
    } catch (err) {
      result.errors.push(`evaluate ${eventId}: ${(err as Error).message}`);
      return;
    }

    const needPlacement = open.filter((l) => l.pWinPlacement == null);
    let placement: ReturnType<Tracker['placementFor']> | null = null;
    try {
      placement = needPlacement.length
        ? this.placementFor(e, needPlacement, allLegs, state)
        : null;
    } catch (err) {
      result.errors.push(`placement ${eventId}: ${(err as Error).message}`);
    }

    const affectedBets = new Set<number>();
    const merge = (json: string | null, outcomes: StoredJoint[]) =>
      JSON.stringify({ ...(json ? JSON.parse(json) : {}), [e.id]: outcomes });
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
          !(
            bet.jointPlacementJson && e.id in JSON.parse(bet.jointPlacementJson)
          )
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
          this.maybeSnapshot(tx, leg, state, ev.outcome.win, now);
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
            .set({ status, settledAt: now, updatedAt: now })
            .where(eq(bets.id, betId))
            .run();
        }
      }
    });
    result.evaluatedEvents.push(eventId);
    result.changedBets.push(...affectedBets);
  }

  private maybeSnapshot(
    tx: Tx,
    leg: LegRow,
    state: GameState,
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
