import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { meta } from '../db/schema.js';
import staticMarkets from './data/oddspapi-markets.json' with { type: 'json' };
import { PAPI_SPORT_IDS, type OddsPapiClient } from './oddsPapi.js';

// OddsPapi's static lookups (sports, bookmakers, markets, tournaments),
// each fetched at most once a day (1 request each, and only when a call
// needs it) and kept in the meta table so a restart doesn't refetch. A
// failed refresh serves the stale copy; the market catalogue falls back to
// the checked-in full-game table when nothing has ever been fetched.

const DAY_MS = 86400_000;
const KEY = (k: string) => `oddspapi_lookup:${k}`;

export type PapiMarketKind = 'h2h' | 'spreads' | 'totals' | 'player_prop';

/** Catalogue key: market ids are only documented as unique per sport. */
export const defKey = (sportId: number, marketId: number | string) =>
  `${sportId}:${marketId}`;

export interface PapiMarketDef {
  marketId: number;
  sportId: number;
  market: PapiMarketKind;
  /** Props: the API's market type, e.g. playertotals-points. */
  propType?: string;
  /** Spreads: participant1's line; totals and props: the line; h2h 0. */
  handicap: number;
  outcomes: { id: number; name: string }[];
}

/** One /v4/markets entry, as documented. */
interface RawMarket {
  marketId: number;
  sportId: number;
  marketType: string;
  period?: string;
  playerProp?: boolean;
  handicap?: number;
  outcomes?: { outcomeId: number; outcomeName: string }[];
}

const GAME_TYPES: Record<string, PapiMarketKind> = {
  moneyline: 'h2h',
  spreads: 'spreads',
  totals: 'totals',
};
const PROP_OUTCOMES = new Set(['over', 'under', 'yes', 'no']);

/**
 * The markets we read: full-game (period "result": incl. OT, extra innings,
 * shootout) moneyline/spreads/totals, and player props whose outcomes are
 * over/under or yes/no. Everything else (halves, quarters, ladders) is out.
 */
export function compactMarkets(raw: RawMarket[]): PapiMarketDef[] {
  const out: PapiMarketDef[] = [];
  for (const m of raw) {
    if (!PAPI_SPORT_IDS.includes(m.sportId)) continue;
    const outcomes = (m.outcomes ?? []).map((o) => ({
      id: o.outcomeId,
      name: o.outcomeName,
    }));
    if (m.playerProp) {
      if (
        outcomes.length !== 2 ||
        !outcomes.every((o) => PROP_OUTCOMES.has(o.name.toLowerCase()))
      )
        continue;
      out.push({
        marketId: m.marketId,
        sportId: m.sportId,
        market: 'player_prop',
        propType:
          m.period && m.period !== 'result'
            ? `${m.marketType}:${m.period}`
            : m.marketType,
        handicap: m.handicap ?? 0,
        outcomes,
      });
      continue;
    }
    const kind = GAME_TYPES[m.marketType];
    if (!kind || m.period !== 'result' || outcomes.length !== 2) continue;
    out.push({
      marketId: m.marketId,
      sportId: m.sportId,
      market: kind,
      handicap: m.handicap ?? 0,
      outcomes,
    });
  }
  return out;
}

/** The checked-in full-game table (no props) in the same shape. */
export function staticCatalog(): PapiMarketDef[] {
  const out: PapiMarketDef[] = [];
  const t = staticMarkets as unknown as Record<
    string,
    Record<string, ['h2h' | 'spreads' | 'totals', number, number, number]>
  >;
  for (const [sportId, defs] of Object.entries(t))
    for (const [id, [market, handicap, first, second]] of Object.entries(defs))
      out.push({
        marketId: Number(id),
        sportId: Number(sportId),
        market,
        handicap,
        outcomes:
          market === 'totals'
            ? [
                { id: first, name: 'Over' },
                { id: second, name: 'Under' },
              ]
            : [
                { id: first, name: '1' },
                { id: second, name: '2' },
              ],
      });
  return out;
}

export class PapiLookups {
  private catalog: { at: string; byId: Map<string, PapiMarketDef> } | null =
    null;

  constructor(
    private readonly db: Db,
    private readonly client: OddsPapiClient,
    private readonly now: () => number = Date.now
  ) {}

  private read<T>(key: string): { at: string; data: T } | null {
    const row = this.db
      .select()
      .from(meta)
      .where(eq(meta.key, KEY(key)))
      .get();
    return row ? (JSON.parse(row.value) as { at: string; data: T }) : null;
  }

  private write(key: string, data: unknown): string {
    const at = new Date(this.now()).toISOString();
    const value = JSON.stringify({ at, data });
    this.db
      .insert(meta)
      .values({ key: KEY(key), value, updatedAt: at })
      .onConflictDoUpdate({ target: meta.key, set: { value, updatedAt: at } })
      .run();
    return at;
  }

  /** A lookup no older than a day; a stale copy if the refresh fails. */
  private async cached<T>(
    key: string,
    load: () => Promise<T>
  ): Promise<{ at: string; data: T }> {
    const hit = this.read<T>(key);
    if (hit && this.now() - Date.parse(hit.at) < DAY_MS) return hit;
    try {
      const data = await load();
      return { at: this.write(key, data), data };
    } catch (e) {
      if (hit) return hit;
      throw e;
    }
  }

  sports() {
    return this.cached('sports', () =>
      this.client.lookup<
        { sportId: number; slug: string; sportName: string }[]
      >('sports')
    ).then((x) => x.data);
  }

  bookmakers() {
    return this.cached('bookmakers', () =>
      this.client.lookup<{ slug: string; bookmakerName: string }[]>(
        'bookmakers'
      )
    ).then((x) => x.data);
  }

  tournaments(sportId: number) {
    return this.cached(`tournaments:${sportId}`, () =>
      this.client.lookup<
        {
          tournamentId: number;
          tournamentSlug: string;
          tournamentName: string;
        }[]
      >('tournaments', { sportId: String(sportId) })
    ).then((x) => x.data);
  }

  /**
   * Market definitions by defKey(sportId, marketId) (our four sports, see compactMarkets). Falls
   * back to the checked-in full-game table if it can't be fetched at all.
   */
  async markets(): Promise<{
    byId: Map<string, PapiMarketDef>;
    source: 'api' | 'static';
  }> {
    let hit: { at: string; data: PapiMarketDef[] };
    try {
      hit = await this.cached('markets', async () =>
        compactMarkets(await this.client.lookup<RawMarket[]>('markets'))
      );
    } catch {
      return {
        byId: new Map(
          staticCatalog().map((d) => [defKey(d.sportId, d.marketId), d])
        ),
        source: 'static',
      };
    }
    if (this.catalog?.at !== hit.at)
      this.catalog = {
        at: hit.at,
        byId: new Map(hit.data.map((d) => [defKey(d.sportId, d.marketId), d])),
      };
    return { byId: this.catalog.byId, source: 'api' };
  }
}
