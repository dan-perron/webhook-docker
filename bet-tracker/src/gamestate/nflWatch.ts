import type { GameState, WatchInfo } from './types.js';

export interface ViewingLocation {
  zipCode: string;
  name: string;
  dmaCode: string;
}
export interface NflCoverage {
  startTime: string;
  home: string;
  away: string;
  networks: string[];
  territory: string;
  dmaCodes: string[];
  hasMap: boolean;
  streams: string[];
  regularSeason: boolean;
}
const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
const streamNames: Record<string, string> = {
  paramount_plus: 'Paramount+',
  paramount: 'Paramount+',
  fox_one: 'FOX One',
  foxone: 'FOX One',
  peacock: 'Peacock',
  espn_unlimited: 'ESPN Unlimited',
  amazon_prime: 'Prime Video',
  netflix: 'Netflix',
};

/** Read JSON from Next's public page payload; never evaluate page scripts. */
export function parseNflGuide(html: string): NflCoverage[] {
  const chunks: string[] = [];
  for (const m of html.matchAll(
    /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g
  )) {
    try {
      chunks.push(JSON.parse(m[1]!));
    } catch {
      /* Ignore incomplete payloads. */
    }
  }
  const games: NflCoverage[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const v of value) walk(v);
      return;
    }
    const o = record(value);
    if (!o) return;
    const home = record(o.homeTeam),
      away = record(o.awayTeam);
    if ('coverageMap' in o && home && away && typeof o.date === 'string') {
      const map = record(o.coverageMap),
        info = record(o.broadcastInfo);
      const networks = strings(map?.networks).length
        ? strings(map?.networks)
        : strings(info?.homeNetworkChannels);
      const auth = record(map?.authorizations);
      const streams = Object.keys(auth ?? {}).flatMap((key) =>
        streamNames[key] ? [streamNames[key]!] : []
      );
      // The official broadcast partner names also identify streaming-only games.
      for (const n of networks)
        if (/prime video|netflix|peacock|youtube/i.test(n)) streams.push(n);
      games.push({
        startTime: o.date,
        home: String(home.fullName ?? ''),
        away: String(away.fullName ?? ''),
        networks,
        territory: String(map?.gameTerritory ?? info?.territory ?? ''),
        dmaCodes: strings(map?.dmaCodes),
        hasMap: strings(map?.dmaCodes).length > 0,
        streams: [...new Set(streams)],
        regularSeason: o.seasonType === 'REG' || o.weekType === 'REG',
      });
      return;
    }
    for (const v of Object.values(o)) walk(v);
  };
  for (const line of chunks.join('').split('\n')) {
    try {
      walk(JSON.parse(line.slice(line.indexOf(':') + 1)));
    } catch {
      /* Other Flight records aren't JSON. */
    }
  }
  return games;
}

const stations: Record<string, string> = {
  CBS: 'CBS 2 · WBBM 2.1',
  FOX: 'FOX 32 · WFLD 32.1',
  NBC: 'NBC 5 · WMAQ 5.1',
  ABC: 'ABC 7 · WLS 7.1',
};
const normalize = (name: string) =>
  name.toUpperCase().replace(/^NFL NET$/, 'NFL NETWORK');
const isOta = (name: string) =>
  ['CBS', 'FOX', 'NBC', 'ABC'].includes(normalize(name));

export function nflWatchInfo(
  state: GameState,
  games: NflCoverage[],
  location: ViewingLocation,
  source: string,
  checkedAt: string
): WatchInfo {
  const game = games.find(
    (g) =>
      g.home === state.home.name &&
      g.away === state.away.name &&
      Date.parse(g.startTime) === Date.parse(state.startTime)
  );
  const networks = game?.networks.length
    ? game.networks
    : (state.broadcasts?.map((b) => b.name) ?? []);
  const otaNetworks = networks.filter(isOta);
  let ota: WatchInfo['ota'] = 'unknown';
  let note = 'Local broadcast coverage is not published yet.';
  const inMarket = game?.hasMap && game.dmaCodes.includes(location.dmaCode);
  // Exclusion alone is insufficient: early maps may be incomplete. Confirm a
  // different game is assigned to this market on the same network/time window.
  const otherAssigned =
    game &&
    games.some(
      (g) =>
        g !== game &&
        g.hasMap &&
        g.dmaCodes.includes(location.dmaCode) &&
        g.networks.some((n) =>
          otaNetworks.some((o) => normalize(n) === normalize(o))
        ) &&
        Math.abs(Date.parse(g.startTime) - Date.parse(game.startTime)) <
          3600_000
    );
  if (game && otaNetworks.length && inMarket) {
    ota = 'yes';
    note =
      'Listed for your TV market. Antenna reception depends on your setup.';
  } else if (game?.hasMap && otaNetworks.length && otherAssigned) {
    ota = 'no';
    note = 'Your local station is showing a different game.';
  } else if (
    game &&
    networks.length > 0 &&
    !otaNetworks.length &&
    ![state.home.abbr, state.away.abbr].includes('CHI') &&
    location.dmaCode === '602'
  ) {
    ota = 'no';
    note = 'Streaming or pay TV required; no Chicago OTA broadcast listed.';
  } else if (game && !otaNetworks.length) {
    note =
      'A local simulcast may be available in the participating teams’ markets; check the game guide.';
  }
  let streams = [...(game?.streams ?? [])];
  // CBS/FOX streaming follows the same regional assignment as the OTA game.
  if (ota === 'no' && otaNetworks.some((n) => /^(CBS|FOX)$/i.test(n))) {
    streams = streams.filter((s) => !['Paramount+', 'FOX One'].includes(s));
    if (game?.regularSeason && new Date(state.startTime).getUTCDay() === 0)
      streams.push('NFL Sunday Ticket');
  }
  return {
    location: `${location.name} ${location.zipCode}`,
    ota,
    channels: networks.map((n) =>
      location.dmaCode === '602' && isOta(n) ? stations[normalize(n)]! : n
    ),
    streams: [...new Set(streams)],
    note,
    source,
    checkedAt,
  };
}

/** One cached public NFL guide request per week, independent of score polling. */
export class NflWatchGuide {
  private cache = new Map<
    string,
    { expires: number; games: NflCoverage[]; checkedAt: string }
  >();
  private pending = new Map<
    string,
    Promise<{ games: NflCoverage[]; checkedAt: string }>
  >();
  constructor(
    private readonly location: ViewingLocation,
    private readonly fetchPage: (url: string) => Promise<string> = async (
      url
    ) => {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'bet-tracker (personal use)' },
      });
      if (!res.ok) throw new Error(`NFL watch guide: ${res.status}`);
      return res.text();
    },
    private readonly now: () => Date = () => new Date()
  ) {}

  private load(source: string) {
    const cached = this.cache.get(source);
    if (cached && cached.expires > this.now().getTime())
      return Promise.resolve(cached);
    const pending = this.pending.get(source);
    if (pending) return pending;
    const request = (async () => {
      const checkedAt = this.now().toISOString();
      let games: NflCoverage[] = [];
      try {
        games = parseNflGuide(await this.fetchPage(source));
      } catch {
        /* Scores must still update if the guide is unavailable. */
      }
      const entry = {
        games,
        checkedAt,
        expires: this.now().getTime() + (games.length ? 3600_000 : 300_000),
      };
      this.cache.set(source, entry);
      return entry;
    })().finally(() => this.pending.delete(source));
    this.pending.set(source, request);
    return request;
  }

  async enrich(states: GameState[], week?: number, seasonType?: number) {
    if (!states.length) return;
    const slug =
      seasonType === 2 && week && week >= 1 && week <= 18
        ? `week-${week}`
        : seasonType === 1 && week && week <= 4
          ? week === 1
            ? 'hall-of-fame-game'
            : `preseason-week-${week - 1}`
          : null;
    const source = slug
      ? `https://www.nfl.com/ways-to-watch/by-week/${slug}`
      : 'https://www.nfl.com/ways-to-watch';
    const { games, checkedAt } = await this.load(source);
    for (const s of states)
      s.watch = nflWatchInfo(s, games, this.location, source, checkedAt);
  }
}
