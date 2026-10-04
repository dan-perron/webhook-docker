import { max } from 'drizzle-orm';
import { legs } from '../db/schema.js';
import type { Services } from '../mcp/server.js';
import type { Quota } from '../odds/oddsApi.js';
import {
  betViews,
  portfolio,
  type BetView,
  type Exposure,
  type LegView,
  type Portfolio,
} from '../tracker/views.js';
import { url } from '../util/url.js';
import {
  american,
  clock,
  legStatusLine,
  pct,
  signedUsd,
  situationText,
  tone,
  usd,
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
  timeZone: string;
}

export function loadDashboard(
  s: Services,
  tab: Tab,
  timeZone: string
): Dashboard {
  const all = betViews(s.db);
  const open = all.filter((b) => b.status === 'open');
  const settled = all
    .filter((b) => b.status !== 'open')
    .sort((a, b) => (b.settledAt ?? '').localeCompare(a.settledAt ?? ''));
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
  };
}

// --- Components -----------------------------------------------------------

export function Summary({ d }: { d: Dashboard }) {
  const o = d.portfolio.open;
  return (
    <div class="summary">
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
      <div class="meta">
        <span>Updated {clock(d.updatedAt, d.timeZone)}</span>
        <span>
          Odds API {d.quota.remaining == null ? '–' : d.quota.remaining} left
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

function LegRow({ l, showP }: { l: LegView; showP: boolean }) {
  const t = tone(l.status, l.pWin);
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
        <div class="state">{legStatusLine(l)}</div>
        {sit ? <div class="sit">{sit}</div> : null}
      </div>
      {showP ? (
        <span class="p">{l.status === 'open' ? pct(l.pWin) : t.label}</span>
      ) : null}
    </li>
  );
}

export function BetCard({ b }: { b: BetView }) {
  const t = tone(b.status, b.now.pWin);
  const placed = b.atPlacement;
  return (
    <article class={`bet ${t.tone}`}>
      <header>
        <span class="icon">{t.icon}</span>
        <div class="title">
          <div class="label">{b.label}</div>
          <div class="sub">{priceLine(b)}</div>
        </div>
        <div class="pwin">
          <div class="big">
            {b.status === 'open' ? pct(b.now.pWin) : t.label}
          </div>
          <div class="sub">{b.status === 'open' ? 'P(win)' : ''}</div>
        </div>
      </header>
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
      {b.tokenInfo ? <div class="note">🎟 {b.tokenInfo}</div> : null}
      {b.sameGameEventIds.length ? (
        <div class="note">
          Same-game legs are treated as independent (correlation not modeled).
        </div>
      ) : null}
      <ul class="legs">
        {b.legs.map((l) => (
          <LegRow l={l} showP={b.legs.length > 1} />
        ))}
      </ul>
    </article>
  );
}

function ExposureTable({ e }: { e: Exposure }) {
  return (
    <div class="exposure card">
      <div class="label">{e.label}</div>
      {e.live ? (
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

export function Content({ d }: { d: Dashboard }) {
  const s = d.portfolio.settled;
  return (
    <div>
      <nav class="tabs">
        <a href={url('/')} class={d.tab === 'open' ? 'on' : ''}>
          Open ({d.counts.open})
        </a>
        <a href={url('/?tab=settled')} class={d.tab === 'settled' ? 'on' : ''}>
          Settled ({d.counts.settled})
        </a>
      </nav>
      {d.tab === 'open' && d.portfolio.exposure.length ? (
        <section>
          <h2>Exposure</h2>
          {d.portfolio.exposure.map((e) => (
            <ExposureTable e={e} />
          ))}
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
      <section>
        {d.bets.length ? (
          d.bets.map((b) => <BetCard b={b} />)
        ) : (
          <p class="empty">
            {d.tab === 'open' ? 'No open bets.' : 'Nothing settled yet.'}
          </p>
        )}
      </section>
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
        <title>{title}</title>
        <link rel="stylesheet" href={url('/static/styles.css')} />
        <script
          src={url('/static/app.js')}
          defer
          data-events={url(`/events?tab=${d.tab}`)}
        />
      </head>
      <body>
        <header id="summary">
          <Summary d={d} />
        </header>
        <main id="content">
          <Content d={d} />
        </main>
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
