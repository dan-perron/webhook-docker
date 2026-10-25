import { SPORTS, type Sport } from '../domain/types.js';
import { SPORT_ICON } from '../scores/alerts.js';
import type {
  FollowView,
  GameCard,
  ScheduleGame,
  ScoreBoard,
} from '../scores/service.js';
import { addDays } from '../util/date.js';
import { home, url } from '../util/url.js';
import type { BetView } from '../tracker/views.js';
import type { DayResults } from './daily.js';
import { Freshness, GameScore } from './game.js';
import { pct, signedUsd, timeLabel, usd, type TimeKind } from './format.js';
import { ViewNav } from './page.js';
import { BetHeadline } from './betHeadline.js';

export interface ScoresPage {
  board: ScoreBoard;
  bets: BetView[];
  today: DayResults | null;
  timeZone: string;
  now: Date;
}

const SPORT_NAME: Record<Sport, string> = {
  nfl: 'NFL',
  ncaaf: 'NCAAF',
  mlb: 'MLB',
  nhl: 'NHL',
  wnba: 'WNBA',
  nba: 'NBA',
  soccer: 'Soccer',
  mma: 'UFC',
  ncaab: 'NCAA MBB',
  ncaamh: 'NCAA Hockey',
  ncaawh: 'NCAA W Hockey',
  ncaawvb: 'NCAA Volleyball',
};

function Time(props: {
  iso: string;
  kind: TimeKind;
  timeZone: string;
  now: Date;
}) {
  return (
    <time datetime={props.iso} data-fmt={props.kind}>
      {timeLabel(props.iso, props.kind, props.timeZone, props.now)}
    </time>
  );
}

/** A one-button POST form (session cookie is SameSite=Lax). */
function Action(props: {
  path: string;
  fields: Record<string, string>;
  label: string;
  title: string;
  cls?: string;
}) {
  return (
    <form method="post" action={url(props.path)} class="inline">
      {Object.entries(props.fields).map(([k, v]) => (
        <input type="hidden" name={k} value={v} />
      ))}
      <button
        type="submit"
        class={`icon-btn ${props.cls ?? ''}`}
        title={props.title}
        aria-label={props.title}
      >
        {props.label}
      </button>
    </form>
  );
}

const localDateOf = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(iso));

export function GameCardView({
  c,
  p,
  back,
  bets = [],
}: {
  c: GameCard;
  p: Pick<ScoresPage, 'timeZone' | 'now'>;
  back: string;
  bets?: BetView[];
}) {
  const { live } = c;
  return (
    <article
      id={`game-${c.eventId}`}
      class={`game ${live.status}`}
      data-sport={c.sport}
    >
      <div class="g-head">
        <span class="g-sport">
          {c.icon} {SPORT_NAME[c.sport]}
        </span>
        {c.bet && !bets.length ? (
          <span class="tag" title="You have an open bet on this game">
            bet
          </span>
        ) : null}
        <span class="g-actions">
          {c.watched ? (
            <>
              <Action
                path="/scores/alerts"
                fields={{ eventId: c.eventId, on: c.alerts ? '0' : '1', back }}
                label={c.alerts ? '🔔' : '🔕'}
                title={c.alerts ? 'Alerts on (tap to mute)' : 'Alerts off'}
              />
              <Action
                path="/scores/unwatch"
                fields={{ eventId: c.eventId, back }}
                label="★"
                title="Stop watching"
                cls="on"
              />
            </>
          ) : (
            <Action
              path="/scores/watch"
              fields={{
                eventId: c.eventId,
                sport: c.sport,
                date: localDateOf(live.startTime, p.timeZone),
                back,
              }}
              label="☆"
              title="Watch (alerts)"
            />
          )}
        </span>
      </div>
      <GameScore
        watchId={`watch-game-${c.eventId}`}
        live={live}
        timeZone={p.timeZone}
        now={p.now}
        fight={c.sport === 'mma'}
      />
      {bets.length ? (
        <div class="game-bets">
          {bets.map((b) => (
            <a
              class="game-bet"
              aria-label={`View ${b.label} ticket`}
              href={`${b.status === 'open' ? home : `${home}?tab=settled`}#bet-${b.id}`}
            >
              <span class="game-bet-selection">
                {b.legs
                  .filter((l) => l.match.eventId === c.eventId)
                  .map((l) => l.selection)
                  .join(' · ')}
              </span>
              <span class="game-bet-estimate">
                {b.status === 'open'
                  ? `${pct(b.now.pWin)} ${b.now.source === 'model' ? 'est. win' : b.now.source === 'book_implied' ? 'book implied' : 'price implied'}`
                  : `${b.status} · ${signedUsd(b.now.ev)}`}
              </span>
              <span class="sub">
                {b.status === 'open'
                  ? `${usd(b.stake)} stake · ${usd(b.payout)} total return if won`
                  : `${usd(b.stake)} staked · ${usd(b.now.value)} returned`}
                {b.legs.length > 1
                  ? ` · ${b.legs.length}-leg parlay · estimate for full ticket`
                  : ''}{' '}
                <span aria-hidden="true">↗</span>
              </span>
            </a>
          ))}
        </div>
      ) : null}
    </article>
  );
}

export function ScoresSummary({ p }: { p: ScoresPage }) {
  const b = p.board;
  const openEV =
    p.bets
      .filter((b) => b.status === 'open')
      .reduce((cents, b) => cents + Math.round(b.now.ev * 100), 0) / 100;
  const times = [...b.live, ...b.upcoming]
    .map((c) => c.live.fetchedAt)
    .filter(Boolean)
    .sort();
  return (
    <div class="summary">
      <ViewNav active="scores" />
      <div class="stats">
        <div>
          <span class="k">Live games</span>
          <span class="v">{b.live.length}</span>
        </div>
        <div>
          <span class="k">Upcoming</span>
          <span class="v">{b.upcoming.length}</span>
        </div>
        <div>
          <BetHeadline settledToday={p.today?.net ?? 0} openEV={openEV} />
        </div>
      </div>
      <div class="meta">
        {times.length ? (
          <Freshness at={times.at(-1)!} now={p.now} live={b.live.length > 0} />
        ) : (
          <span class="muted">
            {b.final.length ? 'All tracked games finished' : 'No active games'}
          </span>
        )}
        <span class="conn" id="conn" role="status" aria-live="polite">
          Connecting…
        </span>
      </div>
    </div>
  );
}

function Section(props: { title: string; games: GameCard[]; p: ScoresPage }) {
  if (!props.games.length) return null;
  return (
    <section data-game-section data-title={props.title}>
      <h2>
        {props.title} ({props.games.length})
      </h2>
      <div class="games">
        {props.games.map((c) => (
          <GameCardView
            c={c}
            p={props.p}
            back="/scores"
            bets={
              c.live.status === 'final'
                ? []
                : props.p.bets.filter(
                    (b) =>
                      b.status === 'open' &&
                      b.legs.some((l) => l.match.eventId === c.eventId)
                  )
            }
          />
        ))}
      </div>
    </section>
  );
}

export function ScoresContent({ p }: { p: ScoresPage }) {
  const b = p.board;
  const games = [...b.live, ...b.upcoming, ...b.final];
  const sports = SPORTS.filter((s) => games.some((c) => c.sport === s));
  return (
    <div>
      {sports.length > 1 ? (
        <nav class="sport-filters" aria-label="Filter games by sport">
          <button
            type="button"
            id="sport-all"
            data-sport-filter="all"
            aria-pressed="true"
          >
            All sports
          </button>
          {sports.map((s) => (
            <button
              type="button"
              id={`sport-${s}`}
              data-sport-filter={s}
              aria-pressed="false"
            >
              {SPORT_NAME[s]}
            </button>
          ))}
        </nav>
      ) : null}
      {!games.length ? (
        <p class="empty">
          No games to follow right now. Add a game or follow a team through MCP.
        </p>
      ) : null}
      <Section title="Live" games={b.live} p={p} />
      <Section title="Completed today" games={b.final} p={p} />
      <Section title="Upcoming" games={b.upcoming} p={p} />
      {b.alerts.length ? (
        <details class="analysis" id="recent-alerts">
          <summary id="recent-alerts-toggle">
            Recent alerts ({b.alerts.length})
          </summary>
          <ul class="alerts card">
            {b.alerts.map((a) => (
              <li>
                <div>{a.title}</div>
                <div class="sub">
                  <Time iso={a.at} kind="time" {...p} /> · {a.body}
                  {a.delivery === 'sent' ? '' : ` · ${a.delivery}`}
                </div>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <details class="analysis" id="notification-details">
        <summary id="notification-toggle">Notifications</summary>
        <p class="note">
          {b.pushConfigured
            ? `Push on${b.quietHours ? ` · quiet ${b.quietHours}` : ''}`
            : 'Push off'}{' '}
          · Manage followed teams and games through MCP.
        </p>
      </details>
    </div>
  );
}

// --- Static pages (no live stream, so forms aren't re-rendered away) ----------

function SubHeader(props: { title: string }) {
  return (
    <div class="summary">
      <ViewNav active="scores" />
      <nav class="subnav">
        <a href={url('/scores')}>← Scores</a>
        <span class="here">{props.title}</span>
      </nav>
    </div>
  );
}

export interface BrowsePage {
  sport: Sport;
  date: string;
  today: string;
  games: ScheduleGame[];
  error?: string;
  timeZone: string;
  now: Date;
}

export function BrowseHeader(props: { p: BrowsePage }) {
  return <SubHeader title={`Add games · ${props.p.date}`} />;
}

export function BrowseContent({ p }: { p: BrowsePage }) {
  const link = (sport: Sport, date: string) =>
    url(`/scores/browse?sport=${sport}&date=${date}`);
  const back = `/scores/browse?sport=${p.sport}&date=${p.date}`;
  return (
    <div>
      <nav class="tabs sports">
        {SPORTS.map((s) => (
          <a href={link(s, p.date)} class={s === p.sport ? 'on' : ''}>
            {SPORT_ICON[s]} {SPORT_NAME[s]}
          </a>
        ))}
      </nav>
      <nav class="dates">
        <a href={link(p.sport, addDays(p.date, -1))}>‹ Prev</a>
        <a href={link(p.sport, p.today)} class={p.date === p.today ? 'on' : ''}>
          Today
        </a>
        <a href={link(p.sport, addDays(p.date, 1))}>Next ›</a>
      </nav>
      {p.error ? <p class="neg">{p.error}</p> : null}
      {p.games.length ? (
        <ul class="schedule card">
          {p.games.map((g) => (
            <li>
              <div class="body">
                <div>{g.label}</div>
                <div class="sub">
                  {g.status === 'pre' ? (
                    <Time iso={g.startTime} kind="start" {...p} />
                  ) : g.status === 'in' ? (
                    'Live'
                  ) : (
                    'Final'
                  )}
                </div>
              </div>
              {g.watched ? (
                <Action
                  path="/scores/unwatch"
                  fields={{ eventId: g.eventId, back }}
                  label="★"
                  title="Stop watching"
                  cls="on"
                />
              ) : (
                <Action
                  path="/scores/watch"
                  fields={{
                    eventId: g.eventId,
                    sport: g.sport,
                    date: p.date,
                    back,
                  }}
                  label="☆"
                  title="Watch"
                />
              )}
            </li>
          ))}
        </ul>
      ) : p.error ? null : (
        <p class="empty">
          No {SPORT_NAME[p.sport]} games on {p.date}.
        </p>
      )}
    </div>
  );
}

export interface TeamsPage {
  follows: FollowView[];
  /** Result of a follow attempt. */
  notice?: { ok: boolean; text: string };
  /** Ambiguous name: follow one of these instead. */
  candidates?: { sport: Sport; names: string[] };
}

export function TeamsHeader() {
  return <SubHeader title="Teams" />;
}

export function TeamsContent({ p }: { p: TeamsPage }) {
  const back = '/scores/teams';
  return (
    <div>
      {p.notice ? (
        <p class={p.notice.ok ? 'pos' : 'neg'}>{p.notice.text}</p>
      ) : null}
      {p.candidates ? (
        <div class="card candidates">
          <div>Which team?</div>
          {p.candidates.names.map((n) => (
            <form method="post" action={url('/scores/follow')} class="inline">
              <input type="hidden" name="sport" value={p.candidates!.sport} />
              <input type="hidden" name="team" value={n} />
              <button type="submit">{n}</button>
            </form>
          ))}
        </div>
      ) : null}
      <form method="post" action={url('/scores/follow')} class="card follow">
        <select name="sport" aria-label="Sport">
          {SPORTS.map((s) => (
            <option value={s}>
              {SPORT_ICON[s]} {SPORT_NAME[s]}
            </option>
          ))}
        </select>
        <input
          name="team"
          placeholder="Team, e.g. Bears"
          required
          autocomplete="off"
        />
        <button type="submit">Follow</button>
      </form>
      <p class="foot">
        A followed team's games in the next week are added to Scores
        automatically.
      </p>
      {p.follows.length ? (
        <ul class="schedule card">
          {p.follows.map((f) => (
            <li>
              <div class="body">
                {f.icon} {f.team}
              </div>
              <Action
                path="/scores/alerts"
                fields={{
                  followId: String(f.id),
                  on: f.alerts ? '0' : '1',
                  back,
                }}
                label={f.alerts ? '🔔' : '🔕'}
                title={f.alerts ? 'Alerts on (tap to mute)' : 'Alerts off'}
              />
              <Action
                path="/scores/unfollow"
                fields={{ followId: String(f.id) }}
                label="✕"
                title="Unfollow"
              />
            </li>
          ))}
        </ul>
      ) : (
        <p class="empty">Not following any teams.</p>
      )}
    </div>
  );
}
