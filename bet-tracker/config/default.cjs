// Normalize a base path: '' (root), or '/bets' (leading slash, no trailing).
function normalizeBasePath(value) {
  if (!value) return '';
  const trimmed = String(value).replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed : '/' + trimmed;
}

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

const config = {
  // Port the Hono server listens on inside the container.
  port: process.env.PORT || 3003,
  // Sub-path the app is served under, e.g. "/bets" when Apache proxies a path
  // on the main domain. Empty = served at the domain root.
  basePath: normalizeBasePath(process.env.BASE_PATH || ''),
  // Absolute origin (no trailing slash). OAuth metadata for the remote MCP
  // endpoint must advertise absolute URLs.
  publicOrigin: (process.env.PUBLIC_ORIGIN || 'http://localhost:3003').replace(
    /\/+$/,
    ''
  ),
  // SQLite file. Lives on a named volume in production.
  databasePath: process.env.DATABASE_PATH || './data/bet-tracker.sqlite',
  timezone: process.env.TZ || 'America/Chicago',
  // Owner's viewing location. ZIP and DMA must describe the same market.
  viewingLocation: { zipCode: '60640', name: 'Chicago', dmaCode: '602' },
  auth: {
    // Bearer token for the HTTP API/MCP and the password for the web login.
    // Empty disables the server (it refuses to start without one outside tests).
    appToken: process.env.APP_TOKEN || '',
    // Extra exact OAuth redirect URIs to accept (comma-separated). Claude's
    // connector callbacks and loopback URIs are always allowed.
    extraRedirectUris: (process.env.OAUTH_EXTRA_REDIRECT_URIS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
  oddsApi: {
    // Never logged. Empty disables odds calls (check_odds returns an error).
    apiKey: process.env.ODDS_API_KEY || '',
    baseUrl: 'https://api.the-odds-api.com/v4',
    // Odds responses are cached this long (seconds).
    cacheSeconds: 60,
    // check_odds calls costing more than this many requests need confirm: true.
    confirmAboveCost: 3,
    // Take one odds snapshot per event shortly before start to set the prior.
    pregameSnapshot: process.env.PREGAME_SNAPSHOT !== 'false',
    // How long before scheduled start the pregame snapshot is taken (minutes).
    pregameSnapshotLeadMinutes: 20,
    regions: 'us',
    // Closing line value: one consensus snapshot per sport shortly before the
    // earliest start in each window of open legs (tracker/clv.ts).
    clv: {
      enabled: process.env.CLV_SNAPSHOTS !== 'false',
      // Minutes before the window's earliest start to fetch (the retry fits
      // before the 4-minute mark). Historical odds are read as of this too.
      leadMinutes: 5,
      // Legs starting this many minutes after the earliest share its snapshot.
      windowMinutes: 15,
      retrySeconds: 60,
      // Below this many requests left, stop until the monthly reset; the rest
      // stay available to check_odds.
      quotaFloor: 40,
      // Historical odds (paid Odds API plans, 10x a live call) for games that
      // started before their snapshot; off = those legs are missed.
      historical: process.env.CLV_HISTORICAL === 'true',
    },
  },
  polling: {
    // Seconds between game-state polls for events with an open bet.
    liveSeconds: 30,
    scheduledSeconds: 600,
  },
  scores: {
    // How many days ahead followed teams' games are added to Scores.
    followDays: 7,
    // Minutes between schedule scans for followed teams' games.
    discoverMinutes: 60,
    // Hours of recent alerts shown; finished watched games stay for their local day.
    finalHours: 18,
    alerts: {
      // Full ntfy topic URL, e.g. https://ntfy.sh/<secret-topic>. Empty = no
      // push (alerts still show on the Scores view).
      ntfyUrl: (process.env.NTFY_URL || '').trim(),
      // Access token for a protected topic (optional).
      ntfyToken: process.env.NTFY_TOKEN || '',
      // "HH:MM-HH:MM" in TZ during which alerts are logged but not pushed.
      quietHours: process.env.SCORES_QUIET_HOURS || '',
    },
  },
  models: {
    // Std dev (points) of the final scoring margin over a full game.
    football: {
      // sigmaRange bounds the per-game σ fitted to the moneyline.
      nfl: {
        marginSigma: envNumber('NFL_MARGIN_SIGMA', 13.5),
        totalSigma: 13,
        sigmaRange: [10, 16],
      },
      ncaaf: {
        marginSigma: envNumber('NCAAF_MARGIN_SIGMA', 15),
        totalSigma: 14,
        sigmaRange: [11, 20],
      },
    },
    // WNBA final margin and total (points); σ fitted per game within the range.
    wnba: { marginSigma: 11.5, totalSigma: 15, sigmaRange: [8, 16] },
    // NBA: same model, 48 minutes.
    nba: { marginSigma: 13, totalSigma: 18, sigmaRange: [9, 17] },
    // Men's college basketball: two 20-minute halves, ~68 possessions a side
    // (NBA ~100), so a tighter final margin and total.
    ncaab: { marginSigma: 11, totalSigma: 15, sigmaRange: [8, 15] },
  },
  props: {
    // Hold assumed when de-vigging an anytime TD price (no "no" side posted):
    // prices up to +200, and longer prices.
    anytimeTdHold: {
      upTo200: envNumber('ATD_HOLD', 0.08),
      above200: envNumber('ATD_HOLD_LONG', 0.15),
    },
    // Hold assumed on an over/under prop price (NBA, MLB) and to hit a HR.
    overUnderHold: {
      upTo200: envNumber('PROP_HOLD', 0.07),
      above200: envNumber('PROP_HOLD_LONG', 0.12),
    },
    // NBA live props: minutes assumed before a player has any, and the
    // weight (in games) of the pregame rate against his pace so far.
    nba: { expectedMinutes: 32, priorWeight: 0.5 },
    // MLB live props: a starter's assumed pitch count (strikeout props),
    // pitches per out, share of PAs that are outs, and the weight (in
    // starts) of the pregame strikeout rate against his pace.
    mlb: {
      pitchBudget: 90,
      pitchesPerOut: 5.6,
      outRate: 0.7,
      priorWeight: 0.5,
    },
  },
};
module.exports = config;
