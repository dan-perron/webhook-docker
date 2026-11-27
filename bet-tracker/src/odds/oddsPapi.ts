import type { Sport } from '../domain/types.js';
import { nameScore, teamAliases } from '../matching/match.js';
import { decimalToAmerican } from './math.js';
import markets from './data/oddspapi-markets.json' with { type: 'json' };
import type {
  OddsBookmaker,
  OddsEvent,
  OddsFetch,
  OddsMarket,
} from './oddsApi.js';

// OddsPapi (api.oddspapi.io/v4): a second source of historical odds for
// closes. Its historical odds are free on settled fixtures (the free plan
// has them; the Odds API's free plan doesn't); finding the fixture costs one
// request per sport window. Its odds are turned into the Odds API's event
// shape, so closes go through the same consensus as every other close.

/** marketId -> [type, handicap, first outcome id, second outcome id]. */
type MarketDef = [OddsMarket, number, number, number];
const MARKETS = markets as unknown as Record<string, Record<string, MarketDef>>;

/**
 * Odds API sport key -> OddsPapi sport, and the tournament (pro leagues) or
 * a tournament-slug test (college: several NCAA tournaments).
 */
export const SPORTS: Record<
  string,
  {
    sport: Sport;
    sportId: number;
    tournamentId?: number;
    slug?: (s: string) => boolean;
  }
> = {
  basketball_nba: { sport: 'nba', sportId: 11, tournamentId: 132 },
  basketball_wnba: { sport: 'wnba', sportId: 11, tournamentId: 486 },
  basketball_ncaab: { sport: 'ncaab', sportId: 11, slug: isMensNcaa },
  americanfootball_nfl: { sport: 'nfl', sportId: 14, tournamentId: 31 },
  americanfootball_ncaaf: { sport: 'ncaaf', sportId: 14, slug: isMensNcaa },
  baseball_mlb: { sport: 'mlb', sportId: 13, tournamentId: 109 },
  icehockey_nhl: { sport: 'nhl', sportId: 15, tournamentId: 234 },
};
/** The OddsPapi sports we cover (basketball, baseball, football, hockey). */
export const PAPI_SPORT_IDS = [11, 13, 14, 15];

function isMensNcaa(slug: string): boolean {
  return slug.includes('ncaa') && !slug.includes('women');
}

export const oddsPapiCovers = (sportKey: string) => sportKey in SPORTS;

/** OddsPapi bookmaker slug -> Odds API bookmaker key (the US region). */
export const ODDSPAPI_BOOKS: Record<string, string> = {
  draftkings: 'draftkings',
  fanduel: 'fanduel',
  betmgm: 'betmgm',
  caesars: 'williamhill_us',
  betrivers: 'betrivers',
  espnbet: 'espnbet',
  fanatics: 'fanatics',
};

/** Historical odds take at most this many bookmakers per call. */
export const BOOKS_PER_CALL = 3;
/**
 * Minimum spacing between calls, per endpoint (the API's own cooldowns). A
 * call inside its cooldown is refused with a 429 that still counts against
 * the quota, so calls wait their turn here rather than retry there.
 */
export const SPACING_MS: Record<string, number> = {
  odds: 500,
  fixture: 500,
  'odds-by-tournaments': 1000,
  sports: 1000,
  tournaments: 1000,
  bookmakers: 1000,
  markets: 1000,
  participants: 1000,
  account: 1000,
  fixtures: 2000,
  'historical-odds': 5000,
};
/** Endpoints that never count against the monthly quota. */
const UNMETERED = new Set(['account', 'historical-odds']);
const TIMEOUT_MS = 8000;

export interface PapiFixture {
  fixtureId: string;
  participant1Name: string;
  participant2Name: string;
  startTime: string;
  statusId: number;
  sportId?: number;
  tournamentId?: number;
  tournamentSlug?: string;
  updatedAt?: string;
}

/** One price in /v4/odds: decimal `price` plus the API's own American. */
export interface PapiOddsEntry {
  active?: boolean;
  price: number;
  priceAmerican?: string | number | null;
  priceFractional?: string | null;
  changedAt?: string | null;
  playerName?: string | null;
  mainLine?: boolean | null;
}

/** /v4/odds: the fixture plus bookmakerOdds[slug].markets[id].outcomes[id]. */
export interface PapiOddsFixture extends PapiFixture {
  bookmakerOdds?: Record<
    string,
    {
      bookmakerIsActive?: boolean;
      suspended?: boolean;
      markets?: Record<
        string,
        {
          marketActive?: boolean;
          outcomes?: Record<
            string,
            { players?: Record<string, PapiOddsEntry> }
          >;
        }
      >;
    }
  >;
}

export interface PapiQuota {
  used: number | null;
  limit: number | null;
  /** Metered requests this process has sent since the last account read. */
  sentSinceRead: number;
  updatedAt: string | null;
}

export interface PapiEntry {
  createdAt: string;
  price: number;
  active?: boolean;
}

export interface PapiHistorical {
  fixtureId: string;
  bookmakers: Record<
    string,
    {
      markets: Record<
        string,
        { outcomes: Record<string, { players: Record<string, PapiEntry[]> }> }
      >;
    }
  >;
}

export interface PapiEventRef {
  homeName: string;
  awayName: string;
  startTime: string;
}

const FIXTURE_GAP_MS = 3 * 3600_000;

/** ISO with any number of fractional digits (the API sends microseconds). */
export const parseTime = (s: string) =>
  Date.parse(s.replace(/(\.\d{3})\d+/, '$1').replace(/\+00:00$/, 'Z'));

/** Our event's fixture: both names match (either way round), nearest start. */
export function findFixture(
  fixtures: PapiFixture[],
  e: PapiEventRef
): { fixture: PapiFixture; homeIsFirst: boolean } | undefined {
  const start = Date.parse(e.startTime);
  const fits = (a: string, b: string) =>
    Math.min(nameScore(a, teamAliases(b)), nameScore(b, teamAliases(a))) >=
    0.85;
  return fixtures
    .map((f) => {
      const gap = Math.abs(Date.parse(f.startTime) - start);
      const straight =
        fits(e.homeName, f.participant1Name) &&
        fits(e.awayName, f.participant2Name);
      const swapped =
        fits(e.homeName, f.participant2Name) &&
        fits(e.awayName, f.participant1Name);
      return {
        fixture: f,
        gap,
        homeIsFirst: straight,
        ok: straight || swapped,
      };
    })
    .filter((x) => x.ok && x.gap < FIXTURE_GAP_MS)
    .sort((a, b) => a.gap - b.gap)
    .map(({ fixture, homeIsFirst }) => ({ fixture, homeIsFirst }))[0];
}

/** The last price at or before asOf; null if none or the line was pulled. */
function priceAsOf(entries: PapiEntry[] | undefined, asOf: number) {
  let last: PapiEntry | undefined;
  let lastAt = -Infinity;
  for (const x of entries ?? []) {
    const t = parseTime(x.createdAt);
    if (t <= asOf && t >= lastAt) {
      last = x;
      lastAt = t;
    }
  }
  return last && last.active !== false && last.price > 1
    ? { price: last.price, at: lastAt }
    : null;
}

/**
 * One fixture's historical odds as an Odds API event, as of `asOf`: per book
 * and market type, the full-game line (moneyline, or the spread/total whose
 * two prices are closest to even, i.e. the book's main line), American odds.
 * home_team/away_team carry OddsPapi's names, oriented to our home side.
 */
export function toOddsEvent(
  fixture: PapiFixture,
  homeIsFirst: boolean,
  hist: PapiHistorical,
  sportId: number,
  wanted: OddsMarket[],
  asOf: number
): OddsEvent {
  const defs = MARKETS[String(sportId)] ?? {};
  const [home, away] = homeIsFirst
    ? [fixture.participant1Name, fixture.participant2Name]
    : [fixture.participant2Name, fixture.participant1Name];
  const bookmakers: OddsBookmaker[] = [];
  for (const [slug, b] of Object.entries(hist.bookmakers ?? {})) {
    const key = ODDSPAPI_BOOKS[slug];
    if (!key) continue;
    const best = new Map<
      OddsMarket,
      {
        handicap: number;
        first: number;
        second: number;
        at: number;
        gap: number;
      }
    >();
    for (const [marketId, m] of Object.entries(b.markets ?? {})) {
      const def = defs[marketId];
      if (!def || !wanted.includes(def[0])) continue;
      const [type, handicap, firstId, secondId] = def;
      const first = priceAsOf(m.outcomes[firstId]?.players['0'], asOf);
      const second = priceAsOf(m.outcomes[secondId]?.players['0'], asOf);
      if (!first || !second) continue;
      const gap = Math.abs(1 / first.price - 1 / second.price);
      const cur = best.get(type);
      if (!cur || gap < cur.gap)
        best.set(type, {
          handicap,
          first: first.price,
          second: second.price,
          at: Math.max(first.at, second.at),
          gap,
        });
    }
    const out: OddsBookmaker['markets'] = [];
    for (const [type, x] of best) {
      const am = (d: number) => decimalToAmerican(d);
      const [homeDec, awayDec] = homeIsFirst
        ? [x.first, x.second]
        : [x.second, x.first];
      const last_update = new Date(x.at).toISOString();
      if (type === 'h2h')
        out.push({
          key: type,
          last_update,
          outcomes: [
            { name: home, price: am(homeDec) },
            { name: away, price: am(awayDec) },
          ],
        });
      else if (type === 'spreads') {
        // The handicap is participant1's.
        const homePoint = homeIsFirst ? x.handicap : -x.handicap;
        out.push({
          key: type,
          last_update,
          outcomes: [
            { name: home, price: am(homeDec), point: homePoint },
            { name: away, price: am(awayDec), point: -homePoint },
          ],
        });
      } else
        out.push({
          key: type,
          last_update,
          outcomes: [
            { name: 'Over', price: am(x.first), point: x.handicap },
            { name: 'Under', price: am(x.second), point: x.handicap },
          ],
        });
    }
    if (out.length)
      bookmakers.push({
        key,
        title: slug,
        last_update: out
          .map((m) => m.last_update!)
          .sort()
          .at(-1)!,
        markets: out,
      });
  }
  return {
    id: `oddspapi:${fixture.fixtureId}`,
    sport_key: '',
    commence_time: new Date(Date.parse(fixture.startTime)).toISOString(),
    home_team: home,
    away_team: away,
    bookmakers,
  };
}

export interface PapiWindowRequest {
  /** Odds API sport key (basketball_nba, ...). */
  sportKey: string;
  markets: OddsMarket[];
  events: PapiEventRef[];
  /** ms: prices as of this time (the close). */
  asOf: number;
}

export interface PapiWindowResult {
  events: OddsEvent[];
  /** Our events with no settled fixture found. */
  unmatched: PapiEventRef[];
  /** Requests spent (fixtures lookups; historical odds are free). */
  cost: number;
}

export class OddsPapiClient {
  private last = new Map<string, number>();
  /** One call at a time per endpoint, so cooldowns hold under concurrency. */
  private queue = new Map<string, Promise<unknown>>();
  /** ETag + body per historical-odds query (finished fixtures only). */
  private etags = new Map<string, { etag: string; body: unknown }>();
  private fixtureCache = new Map<string, { at: number; list: PapiFixture[] }>();
  /** Metered requests sent by this process, ever (for per-call costs). */
  meteredSent = 0;
  private usage: PapiQuota = {
    used: null,
    limit: null,
    sentSinceRead: 0,
    updatedAt: null,
  };

  constructor(
    private readonly opts: {
      apiKey: string;
      baseUrl: string;
      books: string[];
      fetch?: OddsFetch;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
      timeoutMs?: number;
    }
  ) {}

  get books(): string[] {
    return this.opts.books;
  }

  get configured(): boolean {
    return this.opts.apiKey.length > 0;
  }

  /** A window costs one fixtures lookup. */
  costOfWindow(): number {
    return 1;
  }

  covers(sportKey: string): boolean {
    return oddsPapiCovers(sportKey);
  }

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  private get<T>(endpoint: string, params: Record<string, string>): Promise<T> {
    const prev = this.queue.get(endpoint) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => this.send<T>(endpoint, params));
    this.queue.set(endpoint, run);
    return run;
  }

  private async send<T>(
    endpoint: string,
    params: Record<string, string>
  ): Promise<T> {
    if (!this.configured) throw new Error('ODDSPAPI_KEY is not set');
    const sleep =
      this.opts.sleep ??
      ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const cacheKey = `${endpoint}?${new URLSearchParams(params)}`;
    for (let attempt = 0; ; attempt++) {
      const wait =
        (this.last.get(endpoint) ?? -Infinity) +
        (SPACING_MS[endpoint] ?? 1000) -
        this.now();
      if (wait > 0) await sleep(wait);
      this.last.set(endpoint, this.now());
      const q = new URLSearchParams({ ...params, apiKey: this.opts.apiKey });
      const headers: Record<string, string> = {
        'User-Agent': 'bet-tracker',
        Accept: 'application/json',
      };
      const tagged = this.etags.get(cacheKey);
      if (tagged) headers['If-None-Match'] = tagged.etag;
      let res: Awaited<ReturnType<OddsFetch>>;
      try {
        res = await (this.opts.fetch ?? (fetch as unknown as OddsFetch))(
          `${this.opts.baseUrl}/${endpoint}?${q}`,
          {
            headers,
            signal: AbortSignal.timeout(this.opts.timeoutMs ?? TIMEOUT_MS),
          }
        );
      } catch (e) {
        // Never echo the URL: it carries the key.
        const name = (e as Error).name;
        throw new Error(
          `OddsPapi ${endpoint} -> ${name === 'TimeoutError' || name === 'AbortError' ? 'timed out' : 'network error'}`
        );
      }
      if (!UNMETERED.has(endpoint)) {
        this.usage.sentSinceRead++;
        this.meteredSent++;
      }
      if (res.status === 304 && tagged) return tagged.body as T;
      const body = (await res.json().catch(() => null)) as
        (T & { error?: { code?: string; retryMs?: number } }) | null;
      const code = body?.error?.code;
      if (code === 'RATE_LIMITED' && attempt < 2) {
        await sleep((body?.error?.retryMs ?? 1000) + 100);
        continue;
      }
      if (!res.ok || code)
        throw new Error(
          `OddsPapi ${endpoint} -> HTTP ${res.status}${code ? ` ${code}` : ''}`
        );
      const etag = res.headers.get('etag');
      if (etag) this.etags.set(cacheKey, { etag, body });
      return body as T;
    }
  }

  /** Requests used and the plan's monthly limit (the call is unmetered). */
  async quota(): Promise<{ used: number; limit: number } | null> {
    const a = await this.get<{
      subscriptions?: { request_count: number; request_limit: number }[];
    }>('account', {});
    const s = a.subscriptions?.[0];
    return s ? { used: s.request_count, limit: s.request_limit } : null;
  }

  /**
   * Monthly usage, re-read from /v4/account (unmetered: the API sends no
   * usage headers) when this process has spent requests since the last read
   * or the last read is over 10 minutes old. Never throws.
   */
  async usageNow(): Promise<PapiQuota> {
    const stale =
      !this.usage.updatedAt ||
      this.now() - Date.parse(this.usage.updatedAt) > 10 * 60_000;
    if (this.usage.sentSinceRead > 0 || stale) {
      try {
        const q = await this.quota();
        this.usage = {
          used: q?.used ?? null,
          limit: q?.limit ?? null,
          sentSinceRead: 0,
          updatedAt: new Date(this.now()).toISOString(),
        };
      } catch {
        // Keep the last known usage.
      }
    }
    return { ...this.usage };
  }

  /**
   * Upcoming and live fixtures for a sport: one /v4/fixtures call (1
   * request), cached 10 minutes. Pro leagues: the tournament, the next 7
   * days; college: the sport, the next 3 days, men's NCAA slugs.
   */
  async upcomingFixtures(sportKey: string): Promise<{
    fixtures: PapiFixture[];
    cached: boolean;
  }> {
    const hit = this.fixtureCache.get(sportKey);
    if (hit && this.now() - hit.at < 10 * 60_000)
      return { fixtures: hit.list, cached: true };
    const s = SPORTS[sportKey];
    const now = this.now();
    const days = s?.tournamentId ? 7 : 3;
    const list = await this.fixtures(
      sportKey,
      now - 6 * 3600_000,
      now + days * 86400_000
    );
    this.fixtureCache.set(sportKey, { at: now, list });
    return { fixtures: list, cached: false };
  }

  /** One fixture (1 request). */
  async fixture(fixtureId: string): Promise<PapiFixture> {
    return this.get<PapiFixture>('fixture', { fixtureId });
  }

  /** Current odds for one fixture, every book in one call (1 request). */
  async odds(fixtureId: string, books: string[]): Promise<PapiOddsFixture> {
    return this.get<PapiOddsFixture>('odds', {
      fixtureId,
      ...(books.length ? { bookmakers: books.join(',') } : {}),
    });
  }

  /** A static lookup (sports, bookmakers, markets, tournaments): 1 request. */
  async lookup<T>(
    endpoint: 'sports' | 'bookmakers' | 'markets' | 'tournaments',
    params: Record<string, string> = {}
  ): Promise<T> {
    return this.get<T>(endpoint, { language: 'en', ...params });
  }

  async fixtures(
    sportKey: string,
    from: number,
    to: number
  ): Promise<PapiFixture[]> {
    const s = SPORTS[sportKey];
    if (!s) throw new Error(`OddsPapi does not cover ${sportKey}`);
    const iso = (t: number) =>
      new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const list = await this.get<PapiFixture[]>('fixtures', {
      ...(s.tournamentId
        ? { tournamentId: String(s.tournamentId) }
        : { sportId: String(s.sportId) }),
      from: iso(from),
      to: iso(to),
    });
    return list.filter(
      (f) =>
        (!s.tournamentId ||
          f.tournamentId == null ||
          f.tournamentId === s.tournamentId) &&
        (!s.slug || s.slug(f.tournamentSlug ?? ''))
    );
  }

  /**
   * Historical odds for one settled fixture, BOOKS_PER_CALL books a call, 5 s
   * apart (no quota; a repeat sends the ETag and reuses the body on a 304).
   */
  async historical(
    fixtureId: string,
    books: string[] = this.opts.books
  ): Promise<PapiHistorical> {
    const merged: PapiHistorical = { fixtureId, bookmakers: {} };
    for (let i = 0; i < books.length; i += BOOKS_PER_CALL) {
      const part = await this.get<PapiHistorical>('historical-odds', {
        fixtureId,
        bookmakers: books.slice(i, i + BOOKS_PER_CALL).join(','),
      });
      Object.assign(merged.bookmakers, part.bookmakers ?? {});
    }
    return merged;
  }

  /**
   * Closes for one window of our events: one fixtures lookup around their
   * starts, then each matched fixture's historical odds as of `asOf`.
   */
  async historicalWindow(req: PapiWindowRequest): Promise<PapiWindowResult> {
    const starts = req.events.map((e) => Date.parse(e.startTime));
    const fixtures = await this.fixtures(
      req.sportKey,
      Math.min(...starts) - FIXTURE_GAP_MS,
      Math.max(...starts) + FIXTURE_GAP_MS
    );
    const events: OddsEvent[] = [];
    const unmatched: PapiEventRef[] = [];
    const done = new Set<string>();
    for (const e of req.events) {
      const hit = findFixture(fixtures, e);
      if (!hit || hit.fixture.statusId !== 2) {
        unmatched.push(e);
        continue;
      }
      if (done.has(hit.fixture.fixtureId)) continue;
      done.add(hit.fixture.fixtureId);
      const hist = await this.historical(hit.fixture.fixtureId);
      events.push(
        toOddsEvent(
          hit.fixture,
          hit.homeIsFirst,
          hist,
          SPORTS[req.sportKey]!.sportId,
          req.markets,
          req.asOf
        )
      );
    }
    return { events, unmatched, cost: 1 };
  }
}
