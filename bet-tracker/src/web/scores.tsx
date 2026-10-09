import { SPORTS, type Sport } from '../domain/types.js';
import { SPORT_ICON } from '../scores/alerts.js';
import type {
  FollowView,
  GameCard,
  ScheduleGame,
  ScoreBoard,
} from '../scores/service.js';
import { addDays } from '../util/date.js';
import { url } from '../util/url.js';
import { situationText, timeLabel, type TimeKind } from './format.js';
import { ViewNav } from './page.js';

export interface ScoresPage {
  board: ScoreBoard;
  timeZone: string;
  now: Date;
}

const SPORT_NAME: Record<Sport, string> = {
  nfl: 'NFL',
  ncaaf: 'NCAAF',
  mlb: 'MLB',
  nhl: 'NHL',
  wnba: 'WNBA',
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
}: {
  c: GameCard;
  p: Pick<ScoresPage, 'timeZone' | 'now'>;
  back: string;
}) {
  const { live } = c;
  const scored = c.sport !== 'mma' && live.status !== 'pre';
  const sit = situationText(live);
  const row = (side: 'away' | 'home') => {
    const t = live[side];
    return (
      <div class={`team ${c.leader === side ? 'lead' : ''}`}>
        <span class="name">{t.name}</span>
        {scored ? <span class="score">{t.score}</span> : null}
      </div>
    );
  };
  return (
    <article class={`game ${live.status}`}>
      <div class="g-head">
        <span class="g-sport">
          {c.icon} {SPORT_NAME[c.sport]}
        </span>
        <span class="g-status">
          {live.status === 'pre' ? (
            <Time iso={live.startTime} kind="start" {...p} />
          ) : (
            live.detail
          )}
        </span>
        {c.bet ? (
          <span class="tag" title="You have an open bet on this game">
            bet
          </span>
        ) : null}
      </div>
      {row('away')}
      {row('home')}
      {sit ? <div class="sit">{sit}</div> : null}
      <div class="g-actions">
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
      </div>
    </article>
  );
}

export function ScoresSummary({ p }: { p: ScoresPage }) {
  const b = p.board;
  return (
    <div class="summary">
      <ViewNav active="scores" />
      <nav class="subnav">
        <a href={url('/scores/browse')}>＋ Add games</a>
        <a href={url('/scores/teams')}>Teams ({b.follows.length})</a>
      </nav>
      <div class="meta">
        <span>
          {b.live.length} live · {b.upcoming.length} upcoming
        </span>
        <span>
          {b.pushConfigured
            ? `Push on${b.quietHours ? ` · quiet ${b.quietHours}` : ''}`
            : 'Push off (NTFY_URL not set)'}
        </span>
        <span class="conn" id="conn" title="Live updates">
          ●
        </span>
      </div>
    </div>
  );
}

function Section(props: { title: string; games: GameCard[]; p: ScoresPage }) {
  if (!props.games.length) return null;
  return (
    <section>
      <h2>{props.title}</h2>
      {props.games.map((c) => (
        <GameCardView c={c} p={props.p} back="/scores" />
      ))}
    </section>
  );
}

export function ScoresContent({ p }: { p: ScoresPage }) {
  const b = p.board;
  const empty = !b.live.length && !b.upcoming.length && !b.final.length;
  return (
    <div>
      {empty ? (
        <p class="empty">
          No games yet. <a href={url('/scores/browse')}>Add games</a> or{' '}
          <a href={url('/scores/teams')}>follow a team</a>.
        </p>
      ) : null}
      <Section title="Live" games={b.live} p={p} />
      <Section title="Upcoming" games={b.upcoming} p={p} />
      <Section title="Final" games={b.final} p={p} />
      {b.alerts.length ? (
        <section>
          <h2>Recent alerts</h2>
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
        </section>
      ) : null}
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
