import type { Sport } from '../domain/types.js';
import type { GameState } from '../gamestate/types.js';
import { evaluateEvent } from '../models/evaluate.js';
import type { ModelParams, Prior } from '../models/prior.js';
import {
  findOddsEvent,
  sidesSwapped,
  summarizeEvent,
} from '../odds/consensus.js';
import { sportKey, type OddsApiClient } from '../odds/oddsApi.js';
import type { EventRow, LegRow } from '../db/schema.js';

// Debug only: the live market's de-vigged moneyline beside our model's
// P(side wins outright) for each open leg on a game in progress, so drift
// between the state-based model and the market is easy to spot. Never feeds
// pWin. One h2h request per sport, made only when a bet view asks and the
// cache for that sport is cold.

export interface LiveMarketView {
  /** De-vigged consensus P(this leg's side wins the game), across books. */
  marketWin: number;
  books: number;
  /** Our model's P(this leg's side wins the game) at the same state. */
  modelWin: number;
  /** marketWin - modelWin. */
  drift: number;
  /** When the odds were fetched. */
  asOf: string;
}

export interface LiveMarketOptions {
  enabled: boolean;
  /** How long one sport's live h2h stays cached (seconds). */
  cacheSeconds: number;
  /** Skip fetching below this many requests left this month. */
  quotaFloor: number;
}

type Fetched = {
  at: number;
  events: Awaited<ReturnType<OddsApiClient['getOdds']>>['events'];
};

export class LiveMarketCheck {
  private cache = new Map<string, Fetched>();
  private inflight = new Map<string, Promise<Fetched | null>>();

  constructor(
    private readonly client: OddsApiClient,
    private readonly params: ModelParams,
    private readonly opts: LiveMarketOptions,
    private readonly now: () => number = Date.now
  ) {}

  /** Per leg id: the market beside the model, or null when not available. */
  async forLegs(
    ls: { leg: LegRow; event: EventRow | undefined }[]
  ): Promise<Map<number, LiveMarketView | null>> {
    const out = new Map<number, LiveMarketView | null>();
    const live = ls.filter(({ leg, event }) => isComparable(leg, event));
    if (!live.length || !this.opts.enabled || !this.client.configured)
      return out;
    const keys = new Set(live.map(({ event }) => keyFor(event!)));
    const fetched = new Map<string, Fetched | null>();
    await Promise.all(
      [...keys].map(async (k) => fetched.set(k, await this.fetch(k)))
    );
    for (const { leg, event } of live) {
      const f = fetched.get(keyFor(event!));
      let view: LiveMarketView | null = null;
      try {
        view = f ? this.compare(leg, event!, f) : null;
      } catch {
        // Debug only: a bad stored state or prior must not break get_bet.
      }
      out.set(leg.id, view);
    }
    return out;
  }

  private compare(leg: LegRow, e: EventRow, f: Fetched): LiveMarketView | null {
    const o = findOddsEvent(f.events, {
      homeName: e.homeName,
      awayName: e.awayName,
      startTime: e.startTime,
    });
    if (!o) return null;
    const h2h = summarizeEvent(o).markets.find((m) => m.market === 'h2h');
    if (!h2h) return null;
    const flip = sidesSwapped(e.homeName, {
      home: o.home_team,
      away: o.away_team,
    });
    const team = (leg.side === 'home') !== flip ? o.home_team : o.away_team;
    const marketWin = h2h.consensus[team];
    if (marketWin == null) return null;
    const state = JSON.parse(e.stateJson!) as GameState;
    const prior = JSON.parse(leg.priorJson!) as Prior;
    const [ev] = evaluateEvent(
      e.sport,
      state,
      prior,
      [{ market: 'moneyline', kind: 'team', side: leg.side, line: null }],
      { params: this.params }
    );
    const modelWin = ev!.outcome.win;
    const r = (x: number) => Math.round(x * 10000) / 10000;
    return {
      marketWin: r(marketWin),
      books: h2h.books.length,
      modelWin: r(modelWin),
      drift: r(marketWin - modelWin),
      asOf: new Date(f.at).toISOString(),
    };
  }

  private async fetch(key: string): Promise<Fetched | null> {
    const now = this.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < this.opts.cacheSeconds * 1000) return hit;
    const q = this.client.quota();
    if (q.remaining != null && q.remaining < this.opts.quotaFloor)
      return hit ?? null;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = this.client
      .getOdds({ sportKey: key, markets: ['h2h'] })
      .then((r) => {
        const f = { at: now, events: r.events };
        this.cache.set(key, f);
        return f;
      })
      .catch(() => hit ?? null)
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
}

const SIDED = new Set(['moneyline', 'spread']);
const NO_LIVE_ML = new Set<Sport>(['soccer', 'mma']);

function isComparable(leg: LegRow, e: EventRow | undefined): boolean {
  if (leg.status !== 'open' || !leg.side || !SIDED.has(leg.market))
    return false;
  if (!e?.stateJson || !leg.priorJson) return false;
  const st = JSON.parse(e.stateJson) as GameState;
  // Soccer's h2h is 3-way and MMA has no live state: nothing to compare.
  return st.status === 'in' && !NO_LIVE_ML.has(e.sport);
}

const keyFor = (e: EventRow) => sportKey(e.sport, e.league);
