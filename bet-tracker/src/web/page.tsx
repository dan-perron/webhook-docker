import type { Child } from 'hono/jsx';
import { max } from 'drizzle-orm';
import { legs } from '../db/schema.js';
import type { Services } from '../mcp/server.js';
import type { Quota } from '../odds/oddsApi.js';
import {
  calibrationReport,
  type SportCalibration,
} from '../tracker/calibration.js';
import {
  betViews,
  portfolio,
  type BetView,
  type Exposure,
  type LegView,
  type Portfolio,
} from '../tracker/views.js';
import { home, url } from '../util/url.js';
import { Calibration } from './calibration.js';
import { record, settledByDay, type DayResults } from './daily.js';
import {
  american,
  legStatusLine,
  pregameNote,
  pct,
  signedUsd,
  situationText,
  timeLabel,
  tone,
  usd,
  type TimeKind,
} from './format.js';

export type Tab = 'open' | 'settled';

export interface Dashboard {
  tab: Tab;
  portfolio: Portfolio;
  bets: BetView[];
  counts: { open: number; settled: number };
  quota: Quota;
  /** Latest model evaluation of any leg. */
  updatedAt: string | null;
  /** Fallback zone for times before the browser re-renders them. */
  timeZone: string;
  now: Date;
  /** Settled tab only. */
  calibration: SportCalibration[];
  /** Settled bets by settle day (viewer's zone), newest first. */
  days: DayResults[];
  /** Bets settled today, if any. */
  today: DayResults | null;
}

export function loadDashboard(
  s: Services,
  tab: Tab,
  timeZone: string,
  now: Date = new Date()
): Dashboard {
  const all = betViews(s.db);
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
    portfolio: portfolio(s.db),
    bets: tab === 'open' ? open : settled,
    counts: { open: open.length, settled: settled.length },
    quota: s.odds.quota(),
    updatedAt,
    timeZone,
    now,
    calibration: tab === 'settled' ? calibrationReport(s.db) : [],
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

/** Switch between the app's two views. */
export function ViewNav({ active }: { active: 'bets' | 'scores' }) {
  return (
    <nav class="views">
      <a href={home} class={active === 'bets' ? 'on' : ''}>
        Bets
      </a>
      <a href={url('/scores')} class={active === 'scores' ? 'on' : ''}>
        Scores
      </a>
    </nav>
  );
}

export function Summary({ d }: { d: Dashboard }) {
  const o = d.portfolio.open;
  return (
    <div class="summary">
      <ViewNav active="bets" />
      <div class="stats">
        <div>
          <span class="k">Staked</span>
          <span class="v">{usd(o.staked)}</span>
        </div>
        <div>
          <span class="k">Value</span>
          <span class="v">{usd(o.value)}</span>
        </div>
        <div>
          <span class="k">EV now</span>
          <span class={`v ${o.ev >= 0 ? 'pos' : 'neg'}`}>
            {signedUsd(o.ev)}
          </span>
        </div>
      </div>
      <a class="today" href={`${home}?tab=settled`}>
        {d.today ? (
          <>
            Today{' '}
            <span class={d.today.net >= 0 ? 'pos' : 'neg'}>
              {signedUsd(d.today.net)}
            </span>{' '}
            · {record(d.today)} · {d.today.bets.length} settled
          </>
        ) : (
          <span class="muted">Today · no bets settled yet</span>
        )}
      </a>
      <div class="meta">
        <span>
          Updated{' '}
          {d.updatedAt ? (
            <LocalTime iso={d.updatedAt} kind="time" d={d} />
          ) : (
            '–'
          )}
        </span>
        <span>
          {d.quota.remaining == null
            ? 'Odds API quota not checked yet'
            : `Odds API ${d.quota.remaining} left`}
        </span>
        <span class="conn" id="conn" title="Live updates">
          ●
        </span>
      </div>
    </div>
  );
}

function priceLine(b: BetView) {
  const boost = b.boost
    ? ` → ${b.boost.boostedPriceAmerican != null ? american(b.boost.boostedPriceAmerican) : '?'} (${b.boost.pct}% ${b.boost.kind.replace(/_/g, ' ')})`
    : '';
  return `${b.book} · ${american(b.priceAmerican)}${boost}`;
}

/** A game has begun (or ended); before that, probabilities are just the prior. */
const legStarted = (l: LegView) => !!l.live && l.live.status !== 'pre';

function LegRow({ l, showP, d }: { l: LegView; showP: boolean; d: Dashboard }) {
  const t = tone(l.status, l.pWin, legStarted(l));
  const sit = l.live ? situationText(l.live) : null;
  return (
    <li class={`leg ${t.tone}`}>
      <span class="icon" title={t.label}>
        {t.icon}
      </span>
      <div class="body">
        <div class="sel">
          {l.selection} <span class="price">{american(l.priceAmerican)}</span>
        </div>
        <div class="ev">{l.eventLabel}</div>
        <div class="state">
          {legStatusLine(l) ??
            (l.live ? (
              <>
                Starts <LocalTime iso={l.live.startTime} kind="start" d={d} />
                {pregameNote(l.live.detail)
                  ? ` · ${pregameNote(l.live.detail)}`
                  : ''}
              </>
            ) : null)}
        </div>
        {sit ? <div class="sit">{sit}</div> : null}
      </div>
      {showP ? (
        <span class="p">{l.status === 'open' ? pct(l.pWin) : t.label}</span>
      ) : null}
    </li>
  );
}

export function BetCard({ b, d }: { b: BetView; d: Dashboard }) {
  const t = tone(b.status, b.now.pWin, b.legs.some(legStarted));
  const placed = b.atPlacement;
  return (
    <article class={`bet ${t.tone}`}>
      <header>
        <span class="icon">{t.icon}</span>
        <div class="title">
          <div class="label">{b.label}</div>
          <div class="sub">{priceLine(b)}</div>
        </div>
        {b.status === 'open' ? (
          <div class="pwin">
            <div class="big">{pct(b.now.pWin)}</div>
            <div class="sub">P(win)</div>
          </div>
        ) : (
          <div class="pwin">
            <div
              class={`big ${b.now.ev > 0 ? 'pos' : b.now.ev < 0 ? 'neg' : ''}`}
            >
              {signedUsd(b.now.ev)}
            </div>
            <div class="sub">{t.label}</div>
          </div>
        )}
      </header>
      {b.status === 'open' ? (
        <div class="money">
          <span>
            {usd(b.stake)} → {usd(b.payout)}
          </span>
          <span>value {usd(b.now.value)}</span>
          <span class={b.now.ev >= 0 ? 'pos' : 'neg'}>
            EV {signedUsd(b.now.ev)}
          </span>
          {placed ? (
            <span class="muted">at placement {signedUsd(placed.ev)}</span>
          ) : null}
        </div>
      ) : (
        <div class="money">
          <span>
            staked {usd(b.stake)} · returned {usd(b.now.value)}
          </span>
          {placed ? (
            <span class="muted">EV at placement {signedUsd(placed.ev)}</span>
          ) : null}
          {b.settledAt ? (
            <span class="muted">
              settled <LocalTime iso={b.settledAt} kind="start" d={d} />
            </span>
          ) : null}
        </div>
      )}
      {b.tokenInfo ? <div class="note">🎟 {b.tokenInfo}</div> : null}
      {b.now.source === 'book_implied' ? (
        <div class="note">
          Same-game legs: P(win) and EV use the book's unboosted price until
          this game type is modeled jointly.
        </div>
      ) : b.now.source === 'entered_price' ? (
        <div class="note">
          Unmatched legs: valued at their entered price, de-vigged, until
          matched to a game.
        </div>
      ) : b.sameGameEventIds.length ? (
        <div class="note">
          Same-game legs priced together from one game model.
        </div>
      ) : null}
      <ul class="legs">
        {b.legs.map((l) => (
          <LegRow l={l} showP={b.legs.length > 1} d={d} />
        ))}
      </ul>
    </article>
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
      <div class="bet-grid">
        {g.bets.map((b) => (
          <BetCard b={b} d={d} />
        ))}
      </div>
    </section>
  );
}

export function Content({ d }: { d: Dashboard }) {
  const s = d.portfolio.settled;
  return (
    <div>
      <nav class="tabs">
        <a href={home} class={d.tab === 'open' ? 'on' : ''}>
          Open ({d.counts.open})
        </a>
        <a href={`${home}?tab=settled`} class={d.tab === 'settled' ? 'on' : ''}>
          Settled ({d.counts.settled})
        </a>
      </nav>
      {d.tab === 'open' && d.portfolio.exposure.length ? (
        <section>
          <h2>Exposure</h2>
          <div class="bet-grid">
            {d.portfolio.exposure.map((e) => (
              <ExposureTable e={e} d={d} />
            ))}
          </div>
        </section>
      ) : null}
      {d.tab === 'settled' ? (
        <div class="card settled-total">
          {s.count} settled · staked {usd(s.staked)} · returned{' '}
          {usd(s.returned)} ·{' '}
          <span class={s.profit >= 0 ? 'pos' : 'neg'}>
            {signedUsd(s.profit)}
          </span>
        </div>
      ) : null}
      {d.tab === 'open' ? (
        <section>
          {d.bets.length ? (
            <div class="bet-grid">
              {d.bets.map((b) => (
                <BetCard b={b} d={d} />
              ))}
            </div>
          ) : (
            <p class="empty">No open bets.</p>
          )}
        </section>
      ) : (
        <>
          {d.days.length ? (
            d.days.map((g) => <DaySection g={g} d={d} />)
          ) : (
            <p class="empty">Nothing settled yet.</p>
          )}
          <Calibration report={d.calibration} />
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
      events={url(`/events?tab=${d.tab}`)}
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
        <link rel="stylesheet" href={url('/static/styles.css')} />
        <script
          src={url('/static/app.js')}
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
        <link rel="stylesheet" href={url('/static/styles.css')} />
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
