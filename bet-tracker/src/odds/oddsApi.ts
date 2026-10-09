import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { meta } from '../db/schema.js';
import type { Sport } from '../domain/types.js';

// The Odds API v4. Every call costs markets x regions requests (with
// `bookmakers`, each group of 10 books counts as one region). Quota headers
// are stored on every response; responses are cached briefly. The API key is
// sent only as a query parameter to the API and never logged or returned.

export const ODDS_MARKETS = ['h2h', 'spreads', 'totals'] as const;
export type OddsMarket = (typeof ODDS_MARKETS)[number];

/** Our sport (and ESPN soccer league) -> Odds API sport key. */
/** Odds API keys for the sports we price (Scores-only sports have none). */
const SPORT_KEYS: Partial<Record<Exclude<Sport, 'soccer'>, string>> = {
  nfl: 'americanfootball_nfl',
  ncaaf: 'americanfootball_ncaaf',
  mlb: 'baseball_mlb',
  nhl: 'icehockey_nhl',
  wnba: 'basketball_wnba',
  mma: 'mma_mixed_martial_arts',
};
export const SOCCER_LEAGUE_KEYS: Record<string, string> = {
  'uefa.nations': 'soccer_uefa_nations_league',
  'uefa.champions': 'soccer_uefa_champs_league',
  'uefa.euroq': 'soccer_uefa_euro_qualification',
  'fifa.worldq.uefa': 'soccer_fifa_world_cup_qualifiers_europe',
  'eng.1': 'soccer_epl',
  'esp.1': 'soccer_spain_la_liga',
  'ita.1': 'soccer_italy_serie_a',
  'ger.1': 'soccer_germany_bundesliga',
  'fra.1': 'soccer_france_ligue_one',
  'usa.1': 'soccer_usa_mls',
  'mex.1': 'soccer_mexico_ligamx',
  'bra.1': 'soccer_brazil_campeonato',
  'bra.2': 'soccer_brazil_serie_b',
  'arg.1': 'soccer_argentina_primera_division',
  'chi.1': 'soccer_chile_campeonato',
  'eng.2': 'soccer_efl_champ',
  'eng.3': 'soccer_england_league1',
  'eng.4': 'soccer_england_league2',
  'eng.fa': 'soccer_fa_cup',
  'eng.league_cup': 'soccer_england_efl_cup',
  'sco.1': 'soccer_spl',
  'esp.2': 'soccer_spain_segunda_division',
  'ita.2': 'soccer_italy_serie_b',
  'ger.2': 'soccer_germany_bundesliga2',
  'fra.2': 'soccer_france_ligue_two',
  'ned.1': 'soccer_netherlands_eredivisie',
  'por.1': 'soccer_portugal_primeira_liga',
  'bel.1': 'soccer_belgium_first_div',
  'tur.1': 'soccer_turkey_super_league',
  'gre.1': 'soccer_greece_super_league',
  'aut.1': 'soccer_austria_bundesliga',
  'den.1': 'soccer_denmark_superliga',
  'nor.1': 'soccer_norway_eliteserien',
  'swe.1': 'soccer_sweden_allsvenskan',
  'rus.1': 'soccer_russia_premier_league',
  'ksa.1': 'soccer_saudi_arabia_pro_league',
  'jpn.1': 'soccer_japan_j_league',
  'chn.1': 'soccer_china_superleague',
  'aus.1': 'soccer_australia_aleague',
  'uefa.europa': 'soccer_uefa_europa_league',
  'uefa.europa.conf': 'soccer_uefa_europa_conference_league',
  'conmebol.libertadores': 'soccer_conmebol_copa_libertadores',
  'conmebol.sudamericana': 'soccer_conmebol_copa_sudamericana',
  'fifa.worldq.conmebol': 'soccer_fifa_world_cup_qualifiers_south_america',
};

/**
 * Resolve what the caller asked for to an Odds API sport key: one of our
 * sports, an ESPN soccer league ("uefa.nations"), or a raw key.
 */
export function sportKey(sportOrKey: string, league?: string | null): string {
  if (sportOrKey === 'soccer') {
    const key = league ? SOCCER_LEAGUE_KEYS[league] : undefined;
    if (!key) {
      throw new Error(
        `soccer needs a league: one of ${Object.keys(SOCCER_LEAGUE_KEYS).join(', ')}, or an Odds API key like soccer_epl`
      );
    }
    return key;
  }
  const known = SPORT_KEYS[sportOrKey as keyof typeof SPORT_KEYS];
  if (known) return known;
  if (SOCCER_LEAGUE_KEYS[sportOrKey]) return SOCCER_LEAGUE_KEYS[sportOrKey];
  if (/^[a-z0-9]+_[a-z0-9_]+$/.test(sportOrKey)) return sportOrKey;
  throw new Error(`Unknown sport "${sportOrKey}"`);
}

/** Requests a call will cost. */
export function requestCost(
  markets: number,
  regions: number,
  books?: number
): number {
  const regionUnits = books ? Math.ceil(books / 10) : regions;
  return markets * regionUnits;
}

export interface OddsOutcome {
  name: string;
  price: number;
  point?: number;
}
export interface OddsBookmaker {
  key: string;
  title: string;
  last_update: string;
  markets: { key: string; last_update?: string; outcomes: OddsOutcome[] }[];
}
export interface OddsEvent {
  id: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: OddsBookmaker[];
}

export interface Quota {
  remaining: number | null;
  used: number | null;
  /** Cost of the most recent call. */
  last: number | null;
  updatedAt: string | null;
}

export interface OddsRequest {
  sportKey: string;
  markets: OddsMarket[];
  /** Bookmaker keys (fanduel, draftkings, ...). Omit for all US books. */
  books?: string[];
}

export interface OddsResult {
  events: OddsEvent[];
  cost: number;
  cached: boolean;
  quota: Quota;
}

/** Minimal fetch surface so tests can inject recorded responses. */
export type OddsFetch = (url: string) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

const QUOTA_KEY = 'odds_api_quota';

export class OddsApiClient {
  private cache = new Map<string, { at: number; events: OddsEvent[] }>();

  constructor(
    private readonly db: Db,
    private readonly opts: {
      apiKey: string;
      baseUrl: string;
      regions: string;
      cacheSeconds: number;
      fetch?: OddsFetch;
      now?: () => number;
    }
  ) {}

  get configured(): boolean {
    return this.opts.apiKey.length > 0;
  }

  costOf(req: OddsRequest): number {
    return requestCost(
      req.markets.length,
      this.opts.regions.split(',').length,
      req.books?.length
    );
  }

  quota(): Quota {
    const row = this.db
      .select()
      .from(meta)
      .where(eq(meta.key, QUOTA_KEY))
      .get();
    return row
      ? (JSON.parse(row.value) as Quota)
      : { remaining: null, used: null, last: null, updatedAt: null };
  }

  async getOdds(req: OddsRequest): Promise<OddsResult> {
    if (!this.configured) throw new Error('ODDS_API_KEY is not set');
    const now = (this.opts.now ?? Date.now)();
    const params = new URLSearchParams({
      markets: req.markets.join(','),
      oddsFormat: 'american',
      dateFormat: 'iso',
    });
    if (req.books?.length) params.set('bookmakers', req.books.join(','));
    else params.set('regions', this.opts.regions);
    const cacheKey = `${req.sportKey}?${params}`;
    const hit = this.cache.get(cacheKey);
    if (hit && now - hit.at < this.opts.cacheSeconds * 1000) {
      return { events: hit.events, cost: 0, cached: true, quota: this.quota() };
    }

    params.set('apiKey', this.opts.apiKey);
    const url = `${this.opts.baseUrl}/sports/${req.sportKey}/odds?${params}`;
    const res = await (this.opts.fetch ?? (fetch as unknown as OddsFetch))(url);
    // Quota headers come back on errors too.
    const num = (h: string) => {
      const v = res.headers.get(h);
      return v == null || v === '' ? null : Number(v);
    };
    const quota: Quota = {
      remaining: num('x-requests-remaining'),
      used: num('x-requests-used'),
      last: num('x-requests-last'),
      updatedAt: new Date(now).toISOString(),
    };
    if (quota.remaining != null || quota.used != null) this.saveQuota(quota);
    if (!res.ok) {
      // Never echo the URL: it carries the key.
      throw new Error(`Odds API ${req.sportKey} -> HTTP ${res.status}`);
    }
    const events = (await res.json()) as OddsEvent[];
    this.cache.set(cacheKey, { at: now, events });
    return {
      events,
      cost: quota.last ?? this.costOf(req),
      cached: false,
      quota,
    };
  }

  private saveQuota(q: Quota) {
    const value = JSON.stringify(q);
    this.db
      .insert(meta)
      .values({ key: QUOTA_KEY, value })
      .onConflictDoUpdate({
        target: meta.key,
        set: { value, updatedAt: q.updatedAt! },
      })
      .run();
  }
}
