import { assetUrl } from './assets.js';
import type { Child } from 'hono/jsx';
import { max } from 'drizzle-orm';
import { legs } from '../db/schema.js';
import type { Services } from '../mcp/server.js';
import type { Quota } from '../odds/oddsApi.js';
import { UNTAGGED, type OriginFilter } from '../domain/types.js';
import {
  betViews,
  portfolio,
  type BetView,
  type Exposure,
  type LegView,
  type OriginBreakdown,
  type Portfolio,
} from '../tracker/views.js';
import { home, url } from '../util/url.js';
import type { CloseSource } from '../tracker/clv.js';
import { Freshness, GameScore, SeriesScore } from './game.js';
import { BetHeadline } from './betHeadline.js';
import { record, settledByDay, type DayResults } from './daily.js';
import {
  american,
  pct,
  signedUsd,
  timeLabel,
  tone,
  usd,
  type TimeKind,
} from './format.js';

export type Tab = 'open' | 'settled';

export interface Dashboard {
  tab: Tab;
  /** Bets shown only from this origin (none = all). */
  origin?: OriginFilter;
  portfolio: Portfolio;
  bets: BetView[];
  counts: { open: number; settled: number };
  quota: Quota;
  /** Latest model evaluation of any leg. */
  updatedAt: string | null;
  /** Fallback zone for times before the browser re-renders them. */
  timeZone: string;
  now: Date;
  /** Settled bets by settle day (viewer's zone), newest first. */
  days: DayResults[];
  /** Bets settled today, if any. */
  today: DayResults | null;
}

export function loadDashboard(
  s: Services,
  tab: Tab,
  timeZone: string,
  now: Date = new Date(),
  origin?: OriginFilter
): Dashboard {
  const all = betViews(s.db, undefined, origin);
  const open = all.filter((b) => b.status === 'open');
  const settled = all
    .filter((b) => b.status !== 'open')
    .sort((a, b) => (b.settledAt ?? '').localeCompare(a.settledAt ?? ''));
  const days = settledByDay(settled, timeZone, now);
  const updatedAt =
    s.db
      .select({ t: max(legs.evaluatedAt) })
      .from(legs)
      .get()?.t ?? null;
  return {
    tab,
    ...(origin ? { origin } : {}),
    portfolio: portfolio(s.db, origin),
    bets: tab === 'open' ? open : settled,
    counts: { open: open.length, settled: settled.length },
    quota: s.odds.quota(),
    updatedAt,
    timeZone,
    now,
    days,
    today: days.find((g) => g.label === 'Today') ?? null,
  };
}

// --- Components -----------------------------------------------------------

/** A time the browser re-renders in the device's zone (public/app.js). */
function LocalTime(props: { iso: string; kind: TimeKind; d: Dashboard }) {
  return (
    <time datetime={props.iso} data-fmt={props.kind}>
      {timeLabel(props.iso, props.kind, props.d.timeZone, props.d.now)}
    </time>
  );
}

const ORIGIN_LABEL: Record<OriginFilter, string> = {
  recommended: 'Recommended',
  own: 'Own',
  [UNTAGGED]: 'Untagged',
};

/** Where a bet came from (Claude's +EV pick or Dan's own); none if untagged. */
export function OriginBadge({ origin }: { origin: BetView['origin'] }) {
  return origin ? (
    <span class={`origin-badge ${origin}`}>{ORIGIN_LABEL[origin]}</span>
  ) : null;
}

/** All / Recommended / Own / Untagged, keeping the tab. */
export function OriginFilters({ d }: { d: Dashboard }) {
  const href = (o?: OriginFilter) => {
    const q = new URLSearchParams();
    if (d.tab !== 'open') q.set('tab', d.tab);
    if (o) q.set('origin', o);
    const qs = q.toString();
    return qs ? `${home}?${qs}` : home;
  };
  const options: (OriginFilter | undefined)[] = [
    undefined,
    'recommended',
    'own',
    UNTAGGED,
  ];
  return (
    <nav class="origin-filters" aria-label="Filter bets by origin">
      {options.map((o) => (
        <a
          href={href(o)}
          class={d.origin === o ? 'on' : ''}
          aria-current={d.origin === o ? 'page' : undefined}
        >
          {o ? ORIGIN_LABEL[o] : 'All'}
        </a>
      ))}
    </nav>
  );
}

/** Main destinations; game management remains available through MCP. */
export function ViewNav({
  active,
}: {
  active: 'bets' | 'scores' | 'history' | 'settings';
}) {
  return (
    <div class="app-nav">
      <nav class="views" aria-label="Main navigation">
        <a
          href={url('/scores')}
          class={active === 'scores' ? 'on' : ''}
          aria-current={active === 'scores' ? 'page' : undefined}
        >
          Today
        </a>
        <a
          href={home}
          class={active === 'bets' ? 'on' : ''}
          aria-current={active === 'bets' ? 'page' : undefined}
        >
          Bets
        </a>
        <a
          href={`${home}?tab=settled`}
          class={active === 'history' ? 'on' : ''}
          aria-current={active === 'history' ? 'page' : undefined}
        >
          History
        </a>
      </nav>
      <a
        class={`settings-link${active === 'settings' ? ' on' : ''}`}
        href={url('/settings')}
        aria-current={active === 'settings' ? 'page' : undefined}
      >
        Settings
      </a>
    </div>
  );
}

export function Summary({ d }: { d: Dashboard }) {
  if (d.tab === 'settled') {
    return (
      <div class="summary">
        <ViewNav active="history" />
        <OriginFilters d={d} />
        <div class="meta">
          <span class="muted">Settled bets</span>
          <span class="conn" id="conn" role="status" aria-live="polite">
            Connecting…
          </span>
        </div>
      </div>
    );
  }
  const o = d.portfolio.open;
  const live = d.bets.filter(
    (b) =>
      b.status === 'open' &&
      b.legs.some((l) => l.status === 'open' && legLive(l))
  ).length;
  return (
    <div class="summary">
      <ViewNav active="bets" />
      <OriginFilters d={d} />
      <div class="stats">
        <div>
          <span class="k">Open stake</span>
          <span class="v">{usd(o.staked)}</span>
        </div>
        <div>
          <BetHeadline settledToday={d.today?.net ?? 0} openEV={o.ev} />
        </div>
        <div>
          <span class="k">Live bets</span>
          <span class="v">{live}</span>
        </div>
      </div>
      <a class="today" href={`${home}?tab=settled`}>
        {d.today ? (
          <>
            <span class="muted">
              Today · {record(d.today)} · {d.today.bets.length} settled
            </span>
          </>
        ) : (
          <span class="muted">Today · no bets settled yet</span>
        )}
      </a>
      <div class="meta">
        <Freshness at={d.updatedAt} now={d.now} live={live > 0} />
        <span class="conn" id="conn" role="status" aria-live="polite">
          Connecting…
        </span>
      </div>
    </div>
  );
}

function priceLine(b: BetView) {
  const boost = b.boost
    ? ` → ${b.boost.boostedPriceAmerican != null ? american(b.boost.boostedPriceAmerican) : '?'} (${b.boost.pct}% ${b.boost.kind.replace(/_/g, ' ')})`
    : '';
  return `${american(b.priceAmerican)}${boost}`;
}

/** A player prop's box score so far, once its game has started. */
function propText(l: LegView): string | null {
  if (!l.prop || !legStarted(l)) return null;
  if (l.prop.stat) {
    const s = `${l.prop.player}: ${l.prop.stat.value} ${l.prop.stat.name}`;
    return l.prop.note ? `${s} · ${l.prop.note}` : s;
  }
  if (l.prop.note) return l.prop.note;
  if (l.prop.touchdowns == null) return null;
  const n = l.prop.touchdowns;
  return n > 0
    ? `${l.prop.player}: ${n} TD${n > 1 ? 's' : ''}`
    : `${l.prop.player}: no TD${l.live!.status === 'final' ? '' : ' yet'}`;
}

/** A game (or series) has begun; before that, probabilities are the prior. */
const legStarted = (l: LegView) =>
  (!!l.live && l.live.status !== 'pre') ||
  (!!l.series && l.series.status !== 'pre');

/** Its game is on now (series legs: a game of the series is). */
const legLive = (l: LegView) =>
  l.live?.status === 'in' || l.series?.nextGame?.status === 'in';

/** Not started yet (series legs: a game is still to come). */
const legUpcoming = (l: LegView) =>
  l.live?.status === 'pre' ||
  (!!l.series && l.series.status !== 'final' && !legLive(l));

/** When its game starts (series legs: the next game). */
const legStart = (l: LegView) =>
  l.live?.startTime ?? l.series?.nextGame?.startTime ?? '';

function LegRow({
  l,
  showP,
  showSelection = true,
}: {
  l: LegView;
  showP: boolean;
  showSelection?: boolean;
}) {
  const t = tone(l.status, l.pWin, legStarted(l));
  const state =
    l.status !== 'open'
      ? null
      : l.match.status === 'needs_confirmation'
        ? 'Needs event confirmation'
        : l.match.status === 'unmatched'
          ? 'Not matched to an event yet'
          : !l.live && !l.series?.fetchedAt
            ? 'Waiting for first update'
            : null;
  const prop = propText(l);
  if (!showSelection && !state && !prop) return null;
  return (
    <li class={`leg ${l.status === 'open' ? 'idle' : t.tone}`}>
      <div class="body">
        {showSelection ? <div class="sel">{l.selection}</div> : null}
        {state ? <div class="state">{state}</div> : null}
        {prop ? <div class="sit">{prop}</div> : null}
      </div>
      {showP ? (
        <span class="p">{l.status === 'open' ? pct(l.pWin) : t.label}</span>
      ) : null}
    </li>
  );
}

const ratioPct = (r: number | null) =>
  r == null ? '–' : `${r > 0 ? '+' : ''}${(r * 100).toFixed(1)}%`;

/** Probability points, e.g. +1.8 pts. */
const signedPoints = (p: number) =>
  `${p > 0 ? '+' : ''}${(p * 100).toFixed(1)} pts`;

const CLOSE_LABEL: Record<CloseSource, string> = {
  exact: '–',
  interpolated: '–',
  unsupported: 'n/a',
  missed: 'Missed',
  live: 'Live bet',
};

export function BetCard({
  b,
  d,
  showGame = true,
}: {
  b: BetView;
  d: Dashboard;
  showGame?: boolean;
}) {
  const t = tone(b.status, b.now.pWin, b.legs.some(legStarted));
  const normal = (value: string) =>
    value.trim().replace(/\s+/g, ' ').toLowerCase();
  const titleIsSelection =
    b.legs.length === 1 && normal(b.label) === normal(b.legs[0]!.selection);
  const groups = new Map<string, LegView[]>();
  for (const l of b.legs) {
    const key =
      l.match.eventId ??
      l.match.seriesId ??
      `${l.sport}:${l.eventDate}:${l.eventLabel}`;
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  const gameGroups = [...groups.values()];
  const activeGroups = gameGroups.filter(
    (ls) => b.status !== 'open' || ls.some((l) => l.status === 'open')
  );
  const completedGroups =
    b.status === 'open'
      ? gameGroups.filter((ls) => ls.every((l) => l.status !== 'open'))
      : [];
  const gameRank = (ls: LegView[]) =>
    ls.some((l) => l.status === 'open' && legLive(l))
      ? 0
      : ls.some((l) => l.status === 'open' && legUpcoming(l))
        ? 1
        : 2;
  activeGroups.sort(
    (a, b) =>
      gameRank(a) - gameRank(b) ||
      legStart(a[0]!).localeCompare(legStart(b[0]!))
  );
  const renderGame = (ls: LegView[]) => {
    const first = ls[0]!;
    return (
      <div class="ticket-game">
        {showGame && first.series ? (
          <SeriesScore
            series={first.series}
            timeZone={d.timeZone}
            now={d.now}
          />
        ) : showGame && first.live ? (
          <GameScore
            watchId={`watch-bet-${b.id}-${first.id}`}
            live={first.live}
            timeZone={d.timeZone}
            now={d.now}
            fight={first.sport === 'mma'}
          />
        ) : showGame ? (
          <div class="ev">{first.eventLabel}</div>
        ) : null}
        <ul class="legs">
          {ls.map((l) => (
            <LegRow
              l={l}
              showP={b.legs.length > 1}
              showSelection={!titleIsSelection}
            />
          ))}
        </ul>
      </div>
    );
  };
  const won = b.legs.filter((l) => l.status === 'won').length;
  const live = b.legs.some((l) => l.status === 'open' && legLive(l));
  const estimate =
    b.now.source === 'book_implied'
      ? 'Book implied'
      : b.now.source === 'entered_price'
        ? 'Price implied'
        : 'Est. win';
  return (
    <article
      id={`bet-${b.id}`}
      class={`bet ${b.status === 'open' ? (live ? 'in' : 'idle') : t.tone}`}
    >
      <header>
        <div class="title">
          {b.status === 'open' && b.legs.length > 1 ? (
            <div class="ticket-status">
              {won} of {b.legs.length} legs won
            </div>
          ) : null}
          <div class="label">{b.label}</div>
          <div class="sub">
            {b.book} <OriginBadge origin={b.origin} />
          </div>
        </div>
        <div class="pwin">
          <div
            class={`big ${b.status === 'open' ? '' : b.now.ev > 0 ? 'pos' : b.now.ev < 0 ? 'neg' : ''}`}
          >
            {b.status === 'open' ? pct(b.now.pWin) : signedUsd(b.now.ev)}
          </div>
          <div class="sub">{b.status === 'open' ? estimate : t.label}</div>
        </div>
      </header>
      <div class={`ticket-money${b.atClose ? ' with-clv' : ''}`}>
        <div>
          <span class="k">Stake</span>
          <strong>{usd(b.stake)}</strong>
        </div>
        <div>
          <span class="k">
            {b.status === 'open' ? 'Total return if won' : 'Returned'}
          </span>
          <strong>{usd(b.status === 'open' ? b.payout : b.now.value)}</strong>
        </div>
        {b.atClose ? (
          <div>
            <span class="k">CLV</span>
            <strong
              class={
                b.clv == null ? '' : b.clv > 0 ? 'pos' : b.clv < 0 ? 'neg' : ''
              }
            >
              {b.clv == null ? CLOSE_LABEL[b.atClose.source] : ratioPct(b.clv)}
            </strong>
          </div>
        ) : null}
      </div>
      <div class="ticket-games">{activeGroups.map(renderGame)}</div>
      {completedGroups.length ? (
        <details class="ticket-details" id={`completed-legs-${b.id}`}>
          <summary id={`completed-legs-toggle-${b.id}`}>
            Completed legs (
            {completedGroups.reduce((n, ls) => n + ls.length, 0)})
          </summary>
          {completedGroups.map(renderGame)}
        </details>
      ) : null}
      <details class="ticket-details" id={`bet-details-${b.id}`}>
        <summary id={`bet-details-toggle-${b.id}`}>Bet details</summary>
        <div class="sub">{priceLine(b)}</div>
        {b.status === 'open' ? (
          <div class="money">
            <span>value {usd(b.now.value)}</span>
            <span class={b.now.ev >= 0 ? 'pos' : 'neg'}>
              EV {signedUsd(b.now.ev)}
            </span>
            {b.atPlacement ? (
              <span class="muted">
                at placement {signedUsd(b.atPlacement.ev)}
              </span>
            ) : null}
          </div>
        ) : b.atPlacement ? (
          <div class="note">EV at placement {signedUsd(b.atPlacement.ev)}</div>
        ) : null}
        {b.atClose?.ev != null ? (
          <div class="note">
            EV at close {signedUsd(b.atClose.ev)} · P(win) at close{' '}
            {pct(b.atClose.pWin!)}
            {b.atClose.source === 'interpolated'
              ? ' (off the closing line: interpolated)'
              : ''}
          </div>
        ) : null}
        {b.settledAt ? (
          <div class="note">
            Settled <LocalTime iso={b.settledAt} kind="start" d={d} />
          </div>
        ) : null}
        {b.tokenInfo ? <div class="note">🎟 {b.tokenInfo}</div> : null}
        {b.notes ? <div class="note">{b.notes}</div> : null}
        {b.now.source === 'book_implied' ? (
          <div class="note">
            Same-game legs: P(win) and EV use the book's unboosted price until
            this game type is modeled jointly.
          </div>
        ) : b.now.source === 'entered_price' ? (
          <div class="note">
            Price-based estimate: unmatched legs and unsupported props use
            entered prices, not a live game model.
          </div>
        ) : b.sameGameEventIds.length ? (
          <div class="note">
            Same-game legs priced together from one game model.
          </div>
        ) : null}
        {b.legs.length > 1 ? (
          <ul class="leg-prices">
            {b.legs.map((l) => (
              <li>
                {l.selection} · {american(l.priceAmerican)}
                {l.close?.price != null
                  ? ` · closed ${american(l.close.price)}`
                  : ''}
                {l.clv != null ? ` (${signedPoints(l.clv)})` : ''}
              </li>
            ))}
          </ul>
        ) : null}
      </details>
    </article>
  );
}

/** Tickets that share exactly one matched game use one scoreboard. */
function BetList({ bets, d }: { bets: BetView[]; d: Dashboard }) {
  const groups = new Map<string, BetView[]>();
  for (const b of bets) {
    const first = b.legs[0];
    const sharedEvent =
      first?.live &&
      first.match.eventId &&
      b.legs.every((l) => l.live && l.match.eventId === first.match.eventId)
        ? first.match.eventId
        : null;
    const key = sharedEvent ? `event:${sharedEvent}` : `bet:${b.id}`;
    groups.set(key, [...(groups.get(key) ?? []), b]);
  }
  return (
    <div class="bet-grid">
      {[...groups.values()].map((tickets) => {
        const first = tickets[0]!;
        if (tickets.length === 1) return <BetCard b={first} d={d} />;
        const leg = first.legs[0]!;
        return (
          <div class="bet-group" id={`bet-game-${leg.match.eventId}`}>
            <div class="bet-group-score">
              <GameScore
                watchId={`watch-group-${leg.match.eventId}`}
                live={leg.live!}
                timeZone={d.timeZone}
                now={d.now}
                fight={leg.sport === 'mma'}
              />
            </div>
            {tickets.map((b) => (
              <BetCard b={b} d={d} showGame={false} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** Only unresolved legs decide where an open ticket appears. */
export function openBetSection(b: BetView): 'Live' | 'Upcoming' | 'Pending' {
  const open = b.legs.filter((l) => l.status === 'open');
  if (open.some(legLive)) return 'Live';
  if (open.some(legUpcoming)) return 'Upcoming';
  return 'Pending';
}

export function sortOpenBets(bets: BetView[]): BetView[] {
  const rank = { Live: 0, Upcoming: 1, Pending: 2 };
  const start = (b: BetView) =>
    Math.min(
      ...b.legs
        .filter((l) => l.status === 'open' && (legLive(l) || legUpcoming(l)))
        .map((l) => Date.parse(legStart(l)))
        .filter(Number.isFinite)
    );
  return [...bets].sort(
    (a, b) =>
      rank[openBetSection(a)] - rank[openBetSection(b)] ||
      start(a) - start(b) ||
      a.id - b.id
  );
}

function ExposureTable({ e, d }: { e: Exposure; d: Dashboard }) {
  return (
    <div class="exposure card">
      <div class="label">{e.label}</div>
      {e.live?.status === 'pre' ? (
        <div class="sub">
          Starts <LocalTime iso={e.live.startTime} kind="start" d={d} />
        </div>
      ) : e.live ? (
        <div class="sub">{`${e.live.score} · ${e.live.detail}`}</div>
      ) : null}
      <table>
        <thead>
          <tr>
            <th>If…</th>
            {e.outcomes.map((o) => (
              <th>{o.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {e.rows.map((r) => (
            <tr>
              <td>
                {r.label}
                {r.approx ? ' *' : ''}
              </td>
              {e.outcomes.map((o) => (
                <td class={r.pnl[o.key]! >= 0 ? 'pos' : 'neg'}>
                  {signedUsd(r.pnl[o.key]!)}
                </td>
              ))}
            </tr>
          ))}
          <tr class="net">
            <td>Net</td>
            {e.outcomes.map((o) => (
              <td class={e.net[o.key]! >= 0 ? 'pos' : 'neg'}>
                {signedUsd(e.net[o.key]!)}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      <div class="foot">
        Expected P&amp;L per outcome; parlays use their other legs' current odds
        of hitting.
        {e.rows.some((r) => r.approx)
          ? ' * includes spread/total legs at current P(win).'
          : ''}
      </div>
    </div>
  );
}

/** Pick quality by origin, from every bet whose games have reached close. */
export function ClvTable({ rows }: { rows: OriginBreakdown[] }) {
  const withClv = rows.filter((r) => r.clvCount > 0 || r.clvLegCount > 0);
  if (!withClv.length) return null;
  return (
    <table class="origin-table clv-table">
      <thead>
        <tr>
          <th>Origin</th>
          <th>Bets</th>
          <th>Beat the close</th>
          <th>Avg CLV</th>
          <th>EV at close</th>
          <th>At placement</th>
          <th>P/L</th>
        </tr>
      </thead>
      <tbody>
        {withClv.map((r) => (
          <tr>
            <td>{ORIGIN_LABEL[r.origin]}</td>
            <td>{r.clvCount}</td>
            <td>
              {r.pctBeatClose == null ? '–' : pct(r.pctBeatClose)} of{' '}
              {r.clvLegCount} legs
            </td>
            <td>{ratioPct(r.avgClv)}</td>
            <td>{signedUsd(r.evAtClose)}</td>
            <td>{signedUsd(r.evAtPlacementWithClv)}</td>
            <td class={r.profitWithClv >= 0 ? 'pos' : 'neg'}>
              {signedUsd(r.profitWithClv)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Settled results by origin: stake, P/L, ROI, and EV at placement. */
function OriginTable({ rows }: { rows: OriginBreakdown[] }) {
  return (
    <table class="origin-table">
      <thead>
        <tr>
          <th>Origin</th>
          <th>Bets</th>
          <th>Staked</th>
          <th>P/L</th>
          <th>ROI</th>
          <th>EV at placement</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr>
            <td>{ORIGIN_LABEL[r.origin]}</td>
            <td>{r.settled.count}</td>
            <td>{usd(r.settled.staked)}</td>
            <td class={r.settled.profit >= 0 ? 'pos' : 'neg'}>
              {signedUsd(r.settled.profit)}
            </td>
            <td>{ratioPct(r.settled.roi)}</td>
            <td>
              {signedUsd(r.settled.evAtPlacement)} (
              {ratioPct(r.settled.expectedRoi)})
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One settle day: its record and money, then its bets. */
function DaySection({ g, d }: { g: DayResults; d: Dashboard }) {
  return (
    <section class="day">
      <div class="day-head">
        <h2>{g.label}</h2>
        <span class={`net ${g.net > 0 ? 'pos' : g.net < 0 ? 'neg' : ''}`}>
          {signedUsd(g.net)}
        </span>
      </div>
      <div class="day-sub">
        {record(g)} · staked {usd(g.staked)} · returned {usd(g.returned)}
      </div>
      <BetList bets={g.bets} d={d} />
    </section>
  );
}

export function Content({ d }: { d: Dashboard }) {
  const s = d.portfolio.settled;
  const sorted = sortOpenBets(d.bets);
  return (
    <div>
      {d.tab === 'settled' ? (
        <details class="analysis" id="history-totals">
          <summary id="history-totals-toggle">All-time totals</summary>
          <div class="card settled-total">
            {s.count} settled · staked {usd(s.staked)} · returned{' '}
            {usd(s.returned)} ·{' '}
            <span class={s.profit >= 0 ? 'pos' : 'neg'}>
              {signedUsd(s.profit)}
            </span>
          </div>
          {d.portfolio.byOrigin.length ? (
            <div class="card">
              <OriginTable rows={d.portfolio.byOrigin} />
              <ClvTable rows={d.portfolio.byOrigin} />
            </div>
          ) : null}
        </details>
      ) : null}
      {d.tab === 'open' ? (
        <>
          {(['Live', 'Upcoming', 'Pending'] as const).map((label) => {
            const bets = sorted.filter((b) => openBetSection(b) === label);
            return bets.length ? (
              <section>
                <h2>
                  {label} ({bets.length})
                </h2>
                <BetList bets={bets} d={d} />
              </section>
            ) : null;
          })}
          {!d.bets.length ? (
            <p class="empty">
              No open bets. <a href={url('/scores')}>See your games</a>.
            </p>
          ) : null}
          {d.portfolio.exposure.length ? (
            <details class="analysis" id="exposure-details">
              <summary id="exposure-toggle">
                Exposure · {d.portfolio.exposure.length} games
              </summary>
              <div class="bet-grid">
                {d.portfolio.exposure.map((e) => (
                  <ExposureTable e={e} d={d} />
                ))}
              </div>
            </details>
          ) : null}
          <details class="analysis" id="portfolio-details">
            <summary id="portfolio-toggle">Portfolio details</summary>
            <div class="card">
              <div class="money">
                <span>Value {usd(d.portfolio.open.value)}</span>
                <span>EV now {signedUsd(d.portfolio.open.ev)}</span>
                <span>Open ({d.counts.open})</span>
              </div>
              <ClvTable rows={d.portfolio.byOrigin} />
              <div class="note">
                {d.quota.remaining == null
                  ? 'Odds API quota not checked yet'
                  : `Odds API ${d.quota.remaining} left`}
              </div>
            </div>
          </details>
        </>
      ) : (
        <>
          {d.days.length ? (
            d.days.map((g) => <DaySection g={g} d={d} />)
          ) : (
            <p class="empty">Nothing settled yet.</p>
          )}
        </>
      )}
    </div>
  );
}

export function Layout({
  d,
  title = 'Bets',
}: {
  d: Dashboard;
  title?: string;
}) {
  return (
    <Shell
      title={title}
      events={url(
        `/events?tab=${d.tab}${d.origin ? `&origin=${d.origin}` : ''}`
      )}
      timeZone={d.timeZone}
      summary={<Summary d={d} />}
      content={<Content d={d} />}
      wide
    />
  );
}

/**
 * The page frame shared by both views: a sticky #summary header and #content,
 * both replaced from the SSE stream at `events` (none = a static page).
 */
export function Shell(props: {
  title: string;
  events?: string;
  timeZone: string;
  summary: Child;
  content: Child;
  /** Lay cards out in a grid on wide screens (Bets, Scores boards). */
  wide?: boolean;
}) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />
        <meta
          name="theme-color"
          content="#0e1116"
          media="(prefers-color-scheme: dark)"
        />
        <meta
          name="theme-color"
          content="#f6f7f9"
          media="(prefers-color-scheme: light)"
        />
        <title>{props.title}</title>
        <link rel="stylesheet" href={assetUrl('styles.css')} />
        <script
          src={assetUrl('app.js')}
          defer
          data-events={props.events}
          data-base={home}
          data-tz={props.timeZone}
        />
      </head>
      <body class={props.wide ? 'wide' : ''}>
        <header id="summary">{props.summary}</header>
        <main id="content">{props.content}</main>
      </body>
    </html>
  );
}

export function LoginPage({ error }: { error?: string }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Sign in — Bets</title>
        <link rel="stylesheet" href={assetUrl('styles.css')} />
      </head>
      <body>
        <main class="login">
          <form method="post" action={url('/login')} class="card">
            <h1>Bets</h1>
            {error ? <div class="neg">{error}</div> : null}
            <input
              name="app_token"
              type="password"
              placeholder="App token"
              autocomplete="current-password"
              autofocus
              required
            />
            <button type="submit">Sign in</button>
          </form>
        </main>
      </body>
    </html>
  );
}
