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
const SPORTS: Record<
  string,
  { sportId: number; tournamentId?: number; slug?: (s: string) => boolean }
> = {
  basketball_nba: { sportId: 11, tournamentId: 132 },
  basketball_wnba: { sportId: 11, tournamentId: 486 },
  basketball_ncaab: { sportId: 11, slug: isMensNcaa },
  americanfootball_nfl: { sportId: 14, tournamentId: 31 },
  americanfootball_ncaaf: { sportId: 14, slug: isMensNcaa },
  baseball_mlb: { sportId: 13, tournamentId: 109 },
  icehockey_nhl: { sportId: 15, tournamentId: 234 },
};

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
const BOOKS_PER_CALL = 3;
/** Minimum spacing between calls, per endpoint (the API's own limits). */
const SPACING_MS: Record<string, number> = {
  fixtures: 2000,
  'historical-odds': 5000,
  account: 1000,
};

export interface PapiFixture {
  fixtureId: string;
  participant1Name: string;
  participant2Name: string;
  startTime: string;
  statusId: number;
  tournamentId?: number;
  tournamentSlug?: string;
}

interface PapiEntry {
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
const parseTime = (s: string) =>
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

  constructor(
    private readonly opts: {
      apiKey: string;
      baseUrl: string;
      books: string[];
      fetch?: OddsFetch;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
    }
  ) {}

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

  private async get<T>(
    endpoint: string,
    params: Record<string, string>
  ): Promise<T> {
    if (!this.configured) throw new Error('ODDSPAPI_KEY is not set');
    const sleep =
      this.opts.sleep ??
      ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt++) {
      const wait =
        (this.last.get(endpoint) ?? -Infinity) +
        (SPACING_MS[endpoint] ?? 1000) -
        this.now();
      if (wait > 0) await sleep(wait);
      this.last.set(endpoint, this.now());
      const q = new URLSearchParams({ ...params, apiKey: this.opts.apiKey });
      const res = await (this.opts.fetch ?? (fetch as unknown as OddsFetch))(
        `${this.opts.baseUrl}/${endpoint}?${q}`
      );
      const body = (await res.json().catch(() => null)) as
        (T & { error?: { code?: string; retryMs?: number } }) | null;
      const code = body?.error?.code;
      if (code === 'RATE_LIMITED' && attempt < 2) {
        await sleep((body?.error?.retryMs ?? 1000) + 100);
        continue;
      }
      // Never echo the URL: it carries the key.
      if (!res.ok || code)
        throw new Error(
          `OddsPapi ${endpoint} -> HTTP ${res.status}${code ? ` ${code}` : ''}`
        );
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

  /** Historical odds for one settled fixture, BOOKS_PER_CALL books a call. */
  async historical(fixtureId: string): Promise<PapiHistorical> {
    const merged: PapiHistorical = { fixtureId, bookmakers: {} };
    for (let i = 0; i < this.opts.books.length; i += BOOKS_PER_CALL) {
      const part = await this.get<PapiHistorical>('historical-odds', {
        fixtureId,
        bookmakers: this.opts.books.slice(i, i + BOOKS_PER_CALL).join(','),
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
