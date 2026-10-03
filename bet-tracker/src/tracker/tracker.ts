import { EventEmitter } from 'node:events';
import { and, desc, eq, inArray, isNull, lte, ne, or } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import {
  bets,
  events,
  legs,
  predictionSnapshots,
  type EventRow,
  type LegRow,
} from '../db/schema.js';
import { betStatus } from '../domain/value.js';
import type { Providers } from '../gamestate/registry.js';
import type { GameState, PregameLines } from '../gamestate/types.js';
import { matchLegs } from '../matching/service.js';
import { evaluateEvent } from '../models/evaluate.js';
import {
  resolvePrior,
  type EnteredLeg,
  type LinesInput,
  type ModelParams,
  type Prior,
} from '../models/prior.js';
import { seededRng, type Rng } from '../models/stats.js';
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
  rng?: Rng;
}

export interface TickResult {
  polled: string[];
  evaluatedEvents: string[];
  changedBets: number[];
  errors: string[];
}

const iso = (d: Date) => d.toISOString();
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
  private readonly rng: Rng;
  private lastRematch = 0;
  private running = false;

  constructor(
    private readonly db: Db,
    private readonly providers: Providers,
    private readonly opts: TrackerOptions
  ) {
    super();
    this.now = opts.now ?? (() => new Date());
    this.rng = opts.rng ?? seededRng(Date.now() & 0xffffffff);
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

  /** Retry unmatched legs on open bets every so often (events get listed late). */
  private async rematch(result: TickResult) {
    const every = (this.opts.rematchEveryMinutes ?? 10) * 60_000;
    if (this.now().getTime() - this.lastRematch < every) return;
    this.lastRematch = this.now().getTime();
    const ids = this.db
      .select({ id: legs.id })
      .from(legs)
      .innerJoin(bets, eq(bets.id, legs.betId))
      .where(and(eq(legs.matchStatus, 'unmatched'), eq(bets.status, 'open')))
      .all()
      .map((r) => r.id);
    if (ids.length === 0) return;
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

  /** The prior for an event: refreshed until it starts, then frozen on the legs. */
  private priorFor(e: EventRow, eventLegs: LegRow[]): Prior {
    const stored = eventLegs.find((l) => l.priorJson)?.priorJson;
    if (e.status !== 'pre' && stored) return JSON.parse(stored) as Prior;
    const placedLive = new Set(
      this.db
        .select({ id: bets.id })
        .from(bets)
        .where(
          and(
            inArray(
              bets.id,
              eventLegs.map((l) => l.betId)
            ),
            eq(bets.placedLive, true)
          )
        )
        .all()
        .map((b) => b.id)
    );
    const entered: EnteredLeg[] = eventLegs
      .filter((l) => !placedLive.has(l.betId))
      .map((l) => ({
        market: l.market,
        selectionKind: l.selectionKind,
        side: l.side,
        line: l.line,
        price: l.priceAmerican,
      }));
    const parse = <T>(json: string | null) =>
      json ? (JSON.parse(json) as T) : null;
    return resolvePrior(
      e.sport,
      {
        espnLines: parse<PregameLines>(e.providerLinesJson),
        snapshot: parse<LinesInput>(e.pregameOddsJson),
        entered,
      },
      this.opts.params
    );
  }

  /** Re-evaluate every open leg on an event (any bet), settle, snapshot. */
  evaluate(eventId: string, result: TickResult) {
    const e = this.db.select().from(events).where(eq(events.id, eventId)).get();
    if (!e) return;
    // Every leg on the event, so priors see all entered odds; open ones get evaluated.
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
    const prior = this.priorFor(e, allLegs);
    const priorJson = JSON.stringify(prior);
    const now = iso(this.now());
    const params = { params: this.opts.params, rng: this.rng };

    let evals;
    try {
      evals = evaluateEvent(
        e.sport,
        state,
        prior,
        open.map(selectionOf),
        params
      );
    } catch (err) {
      result.errors.push(`evaluate ${eventId}: ${(err as Error).message}`);
      return;
    }

    // Placement probabilities, once: the prior (pregame) or the entered price (live).
    const needPlacement = open.filter((l) => l.pWinPlacement == null);
    const liveBets = new Set(
      needPlacement.length
        ? this.db
            .select({ id: bets.id })
            .from(bets)
            .where(
              and(
                inArray(
                  bets.id,
                  needPlacement.map((l) => l.betId)
                ),
                eq(bets.placedLive, true)
              )
            )
            .all()
            .map((b) => b.id)
        : []
    );
    const pregamePlacement = needPlacement.some((l) => !liveBets.has(l.betId))
      ? evaluateEvent(
          e.sport,
          preState(e),
          prior,
          open.map(selectionOf),
          params
        )
      : null;

    const affectedBets = new Set<number>();
    this.db.transaction((tx) => {
      open.forEach((leg, i) => {
        const ev = evals[i]!;
        let placement: { win: number; push: number } | undefined;
        if (leg.pWinPlacement == null) {
          placement = liveBets.has(leg.betId)
            ? {
                win: devigSingle(
                  leg.priceAmerican,
                  leg.market === 'moneyline3way' ? 0.06 : undefined
                ),
                push: 0,
              }
            : pregamePlacement![i]!.outcome;
        }
        tx.update(legs)
          .set({
            pWin: ev.outcome.win,
            pPush: ev.outcome.push,
            model: ev.model,
            modelInputsJson: JSON.stringify(ev.inputs),
            evaluatedAt: now,
            status: ev.status,
            ...(e.status === 'pre' || !leg.priorJson
              ? { priorSource: prior.source, priorJson }
              : {}),
            ...(placement
              ? { pWinPlacement: placement.win, pPushPlacement: placement.push }
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
      });

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
