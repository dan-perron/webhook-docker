import { and, eq, gte, lte } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { bets, events, legs, meta } from '../db/schema.js';
import { filterEvents } from './consensus.js';
import { americanToDecimal, decimalToAmerican } from './math.js';
import type { OddsApiClient, OddsEvent, OddsMarket } from './oddsApi.js';
import {
  findFixture,
  ODDSPAPI_BOOKS,
  SPORTS,
  type OddsPapiClient,
  type PapiFixture,
  type PapiOddsFixture,
  type PapiQuota,
} from './oddsPapi.js';
import { defKey, type PapiLookups, type PapiMarketDef } from './papiLookups.js';

// Both odds APIs behind one interface returning one normalized shape. Market
// lines only: nothing here feeds pWin/value/ev, which come from game state.

export type OddsProviderName = 'oddsapi' | 'oddspapi';
export type NormMarket = OddsMarket | 'player_prop';
export type NormOutcome =
  'home' | 'away' | 'draw' | 'over' | 'under' | 'yes' | 'no';

export interface NormPrice {
  provider: OddsProviderName;
  /** Odds API bookmaker keys (OddsPapi caesars -> williamhill_us). */
  book: string;
  market: NormMarket;
  /** Props: the provider's market type, e.g. playertotals-points. */
  propType?: string;
  player?: string;
  outcome: NormOutcome;
  /** Spreads: this outcome's own line; totals/props: the line; else null. */
  line: number | null;
  american: number;
  decimal: number;
  /** Which of american/decimal this code derived (the provider sent the other). */
  derived?: 'american' | 'decimal';
  lastUpdated: string;
  /** OddsPapi: the book's main line for this market. */
  mainLine?: boolean;
}

export interface NormEvent {
  provider: OddsProviderName;
  providerEventId: string;
  /** Our event (espn:...) when matched. */
  eventId?: string;
  /** Odds API sport key, e.g. basketball_nba. */
  league: string;
  homeTeam: string;
  awayTeam: string;
  /**
   * Where home/away came from: the provider's own home/away (Odds API),
   * our matched ESPN event, or OddsPapi's participant1 taken as home (it has
   * no home/away; only when no event of ours matched).
   */
  homeAwayFrom: 'provider' | 'espn' | 'participant1';
  startTime: string;
  prices: NormPrice[];
}

export interface ProviderRequest {
  sportKey: string;
  markets: NormMarket[];
  /** Provider book keys; omitted = the provider's default set. */
  books?: string[];
  /** Free-text team filter ("Rams", "Rams @ Eagles"). */
  filter?: string;
  /** Props: keep only players whose name contains this. */
  player?: string;
}

export interface ProviderResult {
  provider: OddsProviderName;
  events: NormEvent[];
  /** Requests this call spent on the provider's monthly quota. */
  cost: number;
  cached: boolean;
  quota: Record<string, number | string | null>;
  warnings: string[];
}

/** A call ready to run, its cost known before it is spent. */
export interface PreparedCall {
  provider: OddsProviderName;
  /** Requests it will spend (upper bound). */
  cost: number;
  run(): Promise<ProviderResult>;
}

export interface OddsProvider {
  readonly name: OddsProviderName;
  readonly configured: boolean;
  covers(sportKey: string): boolean;
  /** May spend requests itself (OddsPapi: the fixtures list, 1, cached). */
  prepare(req: ProviderRequest): Promise<PreparedCall>;
}

const MAX_EVENTS = 10;

// --- The Odds API -----------------------------------------------------------

function oddsApiOutcome(e: OddsEvent, name: string): NormOutcome | null {
  if (name === e.home_team) return 'home';
  if (name === e.away_team) return 'away';
  const n = name.toLowerCase();
  return n === 'draw'
    ? 'draw'
    : n === 'over'
      ? 'over'
      : n === 'under'
        ? 'under'
        : null;
}

/** An Odds API event: American prices as sent, decimal derived from them. */
export function normalizeOddsApi(e: OddsEvent, league: string): NormEvent {
  const prices: NormPrice[] = [];
  for (const b of e.bookmakers)
    for (const m of b.markets) {
      if (!['h2h', 'spreads', 'totals'].includes(m.key)) continue;
      for (const o of m.outcomes) {
        const outcome = oddsApiOutcome(e, o.name);
        if (!outcome) continue;
        prices.push({
          provider: 'oddsapi',
          book: b.key,
          market: m.key as OddsMarket,
          outcome,
          line: o.point ?? null,
          american: o.price,
          decimal: Math.round(americanToDecimal(o.price) * 10000) / 10000,
          derived: 'decimal',
          lastUpdated: m.last_update ?? b.last_update,
        });
      }
    }
  return {
    provider: 'oddsapi',
    providerEventId: e.id,
    league,
    homeTeam: e.home_team,
    awayTeam: e.away_team,
    homeAwayFrom: 'provider',
    startTime: e.commence_time,
    prices,
  };
}

export class OddsApiProvider implements OddsProvider {
  readonly name = 'oddsapi' as const;
  constructor(private readonly client: OddsApiClient) {}
  get configured() {
    return this.client.configured;
  }
  covers() {
    return true;
  }
  async prepare(req: ProviderRequest): Promise<PreparedCall> {
    const markets = req.markets.filter(
      (m): m is OddsMarket => m !== 'player_prop'
    );
    const r = { sportKey: req.sportKey, markets, books: req.books };
    return {
      provider: this.name,
      cost: markets.length ? this.client.costOf(r) : 0,
      run: async () => {
        const warnings = req.markets.includes('player_prop')
          ? ['oddsapi: player props are OddsPapi only here']
          : [];
        if (!markets.length)
          return {
            provider: this.name,
            events: [],
            cost: 0,
            cached: true,
            quota: this.quotaView(),
            warnings,
          };
        const res = await this.client.getOdds(r);
        return {
          provider: this.name,
          events: filterEvents(res.events, req.filter)
            .slice(0, MAX_EVENTS)
            .map((e) => normalizeOddsApi(e, req.sportKey)),
          cost: res.cost,
          cached: res.cached,
          quota: { remaining: res.quota.remaining, used: res.quota.used },
          warnings,
        };
      },
    };
  }
  private quotaView() {
    const q = this.client.quota();
    return { remaining: q.remaining, used: q.used };
  }
}

// --- OddsPapi ---------------------------------------------------------------

/** OddsPapi bookmaker slug <-> our (Odds API) book key. */
export const papiBookKey = (slug: string) => ODDSPAPI_BOOKS[slug] ?? slug;
export function papiSlug(book: string): string {
  return (
    Object.entries(ODDSPAPI_BOOKS).find(([, key]) => key === book)?.[0] ?? book
  );
}
export const isPinnacle = (book: string) => book.startsWith('pinnacle');

/** The API's own American price ("+150", "-110", 150), else derived. */
function papiAmerican(x: {
  price: number;
  priceAmerican?: string | number | null;
}): { american: number; derived: boolean } {
  const n = Number(x.priceAmerican);
  if (x.priceAmerican != null && x.priceAmerican !== '' && Number.isFinite(n))
    return { american: n, derived: false };
  return { american: decimalToAmerican(x.price), derived: true };
}

function papiOutcome(name: string, homeIsFirst: boolean): NormOutcome | null {
  const n = name.toLowerCase();
  if (n === '1') return homeIsFirst ? 'home' : 'away';
  if (n === '2') return homeIsFirst ? 'away' : 'home';
  if (n === 'x' || n === 'draw') return 'draw';
  if (n === 'over' || n === 'under' || n === 'yes' || n === 'no') return n;
  return null;
}

/**
 * One /v4/odds fixture in the normalized shape. Prices are the API's own
 * decimal `price` and `priceAmerican` (derived only if it is missing).
 * Spreads: the market's handicap is participant1's, so participant2's line
 * is its negative; home/away come from `homeIsFirst`.
 */
export function normalizePapi(
  f: PapiOddsFixture,
  catalog: Map<string, PapiMarketDef>,
  opts: {
    sportId: number;
    league: string;
    homeIsFirst: boolean;
    homeAwayFrom: NormEvent['homeAwayFrom'];
    eventId?: string;
    markets: NormMarket[];
    player?: string;
  }
): NormEvent {
  const prices: NormPrice[] = [];
  const wantPlayer = opts.player?.toLowerCase();
  for (const [slug, b] of Object.entries(f.bookmakerOdds ?? {})) {
    if (b.bookmakerIsActive === false || b.suspended) continue;
    for (const [marketId, m] of Object.entries(b.markets ?? {})) {
      const def = catalog.get(defKey(opts.sportId, marketId));
      if (!def || !opts.markets.includes(def.market)) continue;
      if (m.marketActive === false) continue;
      for (const [outcomeId, o] of Object.entries(m.outcomes ?? {})) {
        const od = def.outcomes.find((x) => String(x.id) === outcomeId);
        if (!od) continue;
        const outcome = papiOutcome(od.name, opts.homeIsFirst);
        if (!outcome) continue;
        for (const [playerKey, x] of Object.entries(o.players ?? {})) {
          if (x.active === false || !(x.price > 1)) continue;
          const player =
            def.market === 'player_prop'
              ? (x.playerName ?? `player ${playerKey}`)
              : undefined;
          if (
            wantPlayer &&
            player &&
            !player.toLowerCase().includes(wantPlayer)
          )
            continue;
          const { american, derived } = papiAmerican(x);
          const first = od.name === '1';
          const line =
            def.market === 'h2h'
              ? null
              : def.market === 'spreads'
                ? first
                  ? def.handicap
                  : -def.handicap
                : def.market === 'player_prop' &&
                    (outcome === 'yes' || outcome === 'no')
                  ? null
                  : def.handicap;
          prices.push({
            provider: 'oddspapi',
            book: papiBookKey(slug),
            market: def.market,
            ...(def.propType ? { propType: def.propType } : {}),
            ...(player ? { player } : {}),
            outcome,
            line,
            american,
            decimal: x.price,
            ...(derived ? { derived: 'american' as const } : {}),
            lastUpdated: x.changedAt ?? f.updatedAt ?? f.startTime,
            ...(x.mainLine != null ? { mainLine: x.mainLine } : {}),
          });
        }
      }
    }
  }
  const [home, away] = opts.homeIsFirst
    ? [f.participant1Name, f.participant2Name]
    : [f.participant2Name, f.participant1Name];
  return {
    provider: 'oddspapi',
    providerEventId: f.fixtureId,
    ...(opts.eventId ? { eventId: opts.eventId } : {}),
    league: opts.league,
    homeTeam: home,
    awayTeam: away,
    homeAwayFrom: opts.homeAwayFrom,
    startTime: new Date(Date.parse(f.startTime)).toISOString(),
    prices,
  };
}

/** Keep fixtures whose teams match a free-text filter ("Rams @ Eagles"). */
export function filterFixtures(
  fixtures: PapiFixture[],
  query?: string
): PapiFixture[] {
  if (!query?.trim()) return fixtures;
  const asEvents = fixtures.map((f): OddsEvent => ({
    id: f.fixtureId,
    sport_key: '',
    commence_time: f.startTime,
    home_team: f.participant1Name,
    away_team: f.participant2Name,
    bookmakers: [],
  }));
  const keep = new Set(filterEvents(asEvents, query).map((e) => e.id));
  return fixtures.filter((f) => keep.has(f.fixtureId));
}

const FIXTURE_KEY = (eventId: string) => `oddspapi_fixture:${eventId}`;

export interface FixtureLink {
  fixtureId: string;
  /** Our home team is OddsPapi's participant1. */
  homeIsFirst: boolean;
}

/** A stored fixture link for one of our events. */
export function storedFixture(db: Db, eventId: string): FixtureLink | null {
  const row = db
    .select()
    .from(meta)
    .where(eq(meta.key, FIXTURE_KEY(eventId)))
    .get();
  return row ? (JSON.parse(row.value) as FixtureLink) : null;
}

export function storeFixture(db: Db, eventId: string, link: FixtureLink) {
  const value = JSON.stringify(link);
  db.insert(meta)
    .values({ key: FIXTURE_KEY(eventId), value })
    .onConflictDoUpdate({ target: meta.key, set: { value } })
    .run();
}

/**
 * Our event for an OddsPapi fixture: same sport, both names (either way
 * round, with our aliases) and the nearest start within 3 hours. Stores the
 * link so later calls (historical odds) can skip the lookup.
 */
export function linkFixture(
  db: Db,
  sportKey: string,
  f: PapiFixture
): { eventId: string; homeIsFirst: boolean } | null {
  const sport = SPORTS[sportKey]?.sport;
  if (!sport) return null;
  const t = Date.parse(f.startTime);
  const near = db
    .select()
    .from(events)
    .where(
      and(
        eq(events.sport, sport),
        gte(events.startTime, new Date(t - 3 * 3600_000).toISOString()),
        lte(events.startTime, new Date(t + 3 * 3600_000).toISOString())
      )
    )
    .all();
  const best = near
    .map((e) => ({ e, hit: findFixture([f], e) }))
    .filter((x) => x.hit)
    .sort(
      (a, b) =>
        Math.abs(Date.parse(a.e.startTime) - t) -
        Math.abs(Date.parse(b.e.startTime) - t)
    )[0];
  if (!best) return null;
  storeFixture(db, best.e.id, {
    fixtureId: f.fixtureId,
    homeIsFirst: best.hit!.homeIsFirst,
  });
  return { eventId: best.e.id, homeIsFirst: best.hit!.homeIsFirst };
}

export class OddsPapiProvider implements OddsProvider {
  readonly name = 'oddspapi' as const;
  constructor(
    private readonly db: Db,
    private readonly client: OddsPapiClient,
    private readonly lookups: PapiLookups,
    private readonly opts: {
      /** Added to the default books as the sharp reference. */
      sharpBook?: string;
      now?: () => number;
    } = {}
  ) {}
  get configured() {
    return this.client.configured;
  }
  covers(sportKey: string) {
    return this.client.covers(sportKey);
  }
  defaultBooks(): string[] {
    return [
      ...new Set([...this.client.books, this.opts.sharpBook ?? 'pinnacle']),
    ];
  }

  async prepare(req: ProviderRequest): Promise<PreparedCall> {
    const s = SPORTS[req.sportKey];
    if (!s) throw new Error(`OddsPapi does not cover ${req.sportKey}`);
    const before = this.client.meteredSent;
    const { fixtures, cached } = await this.client.upcomingFixtures(
      req.sportKey
    );
    const listCost = this.client.meteredSent - before;
    const now = (this.opts.now ?? Date.now)();
    const open = fixtures
      .filter((f) => f.statusId === 0 || f.statusId === 1)
      .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
    const picked = req.filter
      ? filterFixtures(open, req.filter)
      : // No filter: the next day's games.
        open.filter((f) => Date.parse(f.startTime) < now + 86400_000);
    const chosen = picked.slice(0, MAX_EVENTS);
    const warnings: string[] = [];
    if (picked.length > chosen.length)
      warnings.push(
        `oddspapi: ${picked.length} fixtures matched; priced the first ${chosen.length}`
      );
    const books = (req.books?.length ? req.books : this.defaultBooks()).map(
      papiSlug
    );
    return {
      provider: this.name,
      cost: listCost + chosen.length,
      run: async () => {
        const { byId, source } = await this.lookups.markets();
        if (source === 'static' && req.markets.includes('player_prop'))
          warnings.push(
            'oddspapi: market catalogue unavailable, props left out'
          );
        const out: NormEvent[] = [];
        const start = this.client.meteredSent;
        for (const f of chosen) {
          const odds = await this.client.odds(f.fixtureId, books);
          const link = linkFixture(this.db, req.sportKey, f);
          out.push(
            normalizePapi({ ...f, ...odds }, byId, {
              sportId: s.sportId,
              league: req.sportKey,
              homeIsFirst: link ? link.homeIsFirst : true,
              homeAwayFrom: link ? 'espn' : 'participant1',
              ...(link ? { eventId: link.eventId } : {}),
              markets: req.markets,
              ...(req.player ? { player: req.player } : {}),
            })
          );
        }
        const cost = listCost + (this.client.meteredSent - start);
        const quota = await this.client.usageNow();
        return {
          provider: this.name,
          events: out,
          cost,
          cached: cached && chosen.length === 0,
          quota: quotaView(quota),
          warnings,
        };
      },
    };
  }
}

export function quotaView(q: PapiQuota) {
  return {
    used: q.used,
    limit: q.limit,
    remaining: q.used != null && q.limit != null ? q.limit - q.used : null,
    updatedAt: q.updatedAt,
  };
}

export interface FixtureTarget {
  fixture: PapiFixture;
  homeIsFirst: boolean;
  sportId: number;
  eventId?: string;
  /** The bet's placedAt, when asked about a leg. */
  betAt?: string;
  leg?: {
    legId: number;
    betId: number;
    market: string;
    selection: string | null;
    side: string | null;
    line: number | null;
    price: number;
  };
}

/**
 * The OddsPapi fixture for a leg, one of our events or a fixtureId. Our
 * events use their stored link (no request) or one fixtures lookup around
 * their start (1 request; the link is then stored); a fixtureId costs one
 * /v4/fixture call and is oriented by our matching event when there is one.
 */
export async function findFixtureFor(
  db: Db,
  client: OddsPapiClient,
  a: { legId?: number; eventId?: string; fixtureId?: string }
): Promise<FixtureTarget> {
  let eventId = a.eventId;
  let leg: FixtureTarget['leg'];
  let betAt: string | undefined;
  if (a.legId != null) {
    const row = db
      .select({ leg: legs, bet: bets })
      .from(legs)
      .innerJoin(bets, eq(bets.id, legs.betId))
      .where(eq(legs.id, a.legId))
      .get();
    if (!row) throw new Error(`No leg ${a.legId}`);
    if (!row.leg.eventId)
      throw new Error(`Leg ${a.legId} is not matched to a game`);
    eventId = row.leg.eventId;
    leg = {
      legId: row.leg.id,
      betId: row.bet.id,
      market: row.leg.market,
      selection: row.leg.selectionTeam ?? row.leg.selectionKind,
      side: row.leg.side,
      line: row.leg.line,
      price: row.leg.priceAmerican,
    };
    betAt = row.bet.placedAt ?? undefined;
  }
  if (eventId) {
    const e = db.select().from(events).where(eq(events.id, eventId)).get();
    if (!e) throw new Error(`No event ${eventId}`);
    const sportKey = Object.keys(SPORTS).find(
      (k) => SPORTS[k]!.sport === e.sport
    );
    if (!sportKey) throw new Error(`OddsPapi does not cover ${e.sport}`);
    const sportId = SPORTS[sportKey]!.sportId;
    const link = storedFixture(db, e.id);
    if (link) {
      const [p1, p2] = link.homeIsFirst
        ? [e.homeName, e.awayName]
        : [e.awayName, e.homeName];
      return {
        fixture: {
          fixtureId: link.fixtureId,
          participant1Name: p1,
          participant2Name: p2,
          startTime: e.startTime,
          statusId: e.status === 'final' ? 2 : 0,
        },
        homeIsFirst: link.homeIsFirst,
        sportId,
        eventId: e.id,
        ...(betAt ? { betAt } : {}),
        ...(leg ? { leg } : {}),
      };
    }
    const t = Date.parse(e.startTime);
    const list = await client.fixtures(
      sportKey,
      t - 3 * 3600_000,
      t + 3 * 3600_000
    );
    const hit = findFixture(list, e);
    if (!hit)
      throw new Error(
        `OddsPapi has no fixture for ${e.awayName} @ ${e.homeName} ${e.startTime}`
      );
    storeFixture(db, e.id, {
      fixtureId: hit.fixture.fixtureId,
      homeIsFirst: hit.homeIsFirst,
    });
    return {
      fixture: hit.fixture,
      homeIsFirst: hit.homeIsFirst,
      sportId,
      eventId: e.id,
      ...(betAt ? { betAt } : {}),
      ...(leg ? { leg } : {}),
    };
  }
  if (!a.fixtureId) throw new Error('Give legId, eventId or fixtureId');
  const f = await client.fixture(a.fixtureId);
  const sportKey = Object.keys(SPORTS).find((k) => {
    const s = SPORTS[k]!;
    return s.tournamentId
      ? s.tournamentId === f.tournamentId
      : s.sportId === f.sportId && !!s.slug?.(f.tournamentSlug ?? '');
  });
  const link = sportKey ? linkFixture(db, sportKey, f) : null;
  return {
    fixture: f,
    homeIsFirst: link ? link.homeIsFirst : true,
    sportId: f.sportId ?? (sportKey ? SPORTS[sportKey]!.sportId : 0),
    ...(link ? { eventId: link.eventId } : {}),
  };
}
