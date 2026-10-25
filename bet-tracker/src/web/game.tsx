import type { LiveView, SeriesView } from '../tracker/views.js';
import {
  freshnessLabel,
  pregameNote,
  situationText,
  timeLabel,
} from './format.js';

export function Freshness(props: {
  at: string | null;
  now: Date;
  live?: boolean;
  staleOnly?: boolean;
}) {
  const staleAfter = props.live ? 120 : 1200;
  const stale =
    props.at && props.now.getTime() - Date.parse(props.at) > staleAfter * 1000;
  return (
    <span
      class={`freshness${stale ? ' stale' : ''}`}
      data-freshness={props.at ?? ''}
      data-stale-after={staleAfter}
      data-stale-only={props.staleOnly ? 'true' : undefined}
      hidden={
        props.staleOnly && !stale && Number.isFinite(Date.parse(props.at ?? ''))
      }
      title={
        props.at ? `Last data update: ${props.at}` : 'Waiting for game data'
      }
    >
      {freshnessLabel(props.at, props.now)}
      {stale ? ' · stale data' : ''}
    </span>
  );
}

/** Shared score presentation for a ticket and the Today board. */
export function GameScore(props: {
  live: LiveView;
  timeZone: string;
  now: Date;
  fight?: boolean;
  watchId?: string;
}) {
  const { live } = props;
  const started = live.status !== 'pre';
  const situation = situationText(live);
  const baseballSituation =
    live.status === 'in' &&
    live.situation?.kind === 'baseball' &&
    !pregameNote(live.detail);
  const clock = baseballSituation ? situation : live.detail;
  const separateSituation =
    situation && !baseballSituation && !live.detail.includes(situation)
      ? situation
      : null;
  return (
    <div class="scoreboard">
      <div class="game-meta">
        <div class={`game-clock ${live.status}`}>
          {live.status === 'pre' ? (
            <>
              Starts{' '}
              <time datetime={live.startTime} data-fmt="start">
                {timeLabel(live.startTime, 'start', props.timeZone, props.now)}
              </time>
              {pregameNote(live.detail) ? ` · ${pregameNote(live.detail)}` : ''}
            </>
          ) : (
            <>
              {live.status === 'in' ? 'Live · ' : ''}
              {clock || (live.status === 'final' ? 'Final' : 'In progress')}
            </>
          )}
        </div>
        {live.status !== 'final' ? (
          <WatchDetails live={live} now={props.now} id={props.watchId} />
        ) : null}
      </div>
      {(['away', 'home'] as const).map((side) => {
        const team = live[side];
        const other = live[side === 'away' ? 'home' : 'away'];
        return (
          <div
            class={`team${started && !props.fight && team.score > other.score ? ' lead' : ''}`}
          >
            <span class="name">{team.name}</span>
            {started && !props.fight ? (
              <span class="score">{team.score}</span>
            ) : null}
          </div>
        );
      })}
      {separateSituation ? <div class="sit">{separateSituation}</div> : null}
      {live.status !== 'final' ? (
        <Freshness
          at={live.fetchedAt}
          now={props.now}
          live={live.status === 'in'}
          staleOnly
        />
      ) : null}
    </div>
  );
}

/** A single compact watch row shared by Today and bet scoreboards. */
export function WatchDetails({
  live,
  now,
  id,
}: {
  live: LiveView;
  now: Date;
  id?: string;
}) {
  const watch = live.watch;
  const fresh =
    watch && now.getTime() - Date.parse(watch.checkedAt) <= 2 * 3600_000;
  const ota = fresh ? watch.ota : 'unknown';
  const channels = watch?.channels.length
    ? watch.channels
    : (live.broadcasts?.map((b) => b.name) ?? []);
  const names = live.broadcasts?.map((b) => b.name) ?? [];
  const label = names.length
    ? names.join(' / ')
    : channels.length
      ? channels.join(' / ')
      : 'TV ?';
  const availability =
    live.sport === 'nfl'
      ? ota === 'yes'
        ? `OTA in ${watch!.location}`
        : ota === 'no'
          ? `No OTA in ${watch!.location}`
          : 'Local coverage unconfirmed'
      : null;
  return (
    <details
      class="watch-details"
      id={id}
      data-watch-checked={watch?.checkedAt}
    >
      <summary
        id={id ? `${id}-toggle` : undefined}
        title={`Watch: ${label}${availability ? ` · ${availability}` : ''}`}
      >
        <span class="watch-channel">{label}</span>
        {availability ? (
          <span class={`watch-availability ${ota}`} aria-label={availability}>
            {ota === 'yes' ? 'OTA' : ota === 'no' ? 'No OTA' : 'OTA ?'}
          </span>
        ) : null}
      </summary>
      <div class="watch-options">
        {availability ? <p class="watch-location">{availability}</p> : null}
        {channels.length ? (
          <p>
            <strong>TV / app:</strong> {channels.join(' / ')}
          </p>
        ) : (
          <p>TV / stream not listed yet.</p>
        )}
        {fresh && watch.streams.length ? (
          <p class="watch-streams">
            <strong>Streaming:</strong> {watch.streams.join(' / ')} ·
            subscription required
          </p>
        ) : null}
        {live.sport === 'nfl' ? (
          <p class="watch-note">
            {fresh
              ? watch.note
              : 'Chicago 60640 coverage is unconfirmed. Check the game guide for the latest assignment.'}
          </p>
        ) : live.broadcasts?.some((b) => b.scope !== 'national') ? (
          <p>
            Regional channels and streaming access depend on your location and
            provider.
          </p>
        ) : null}
        {watch ? (
          <p>
            <a href={watch.source} target="_blank" rel="noopener noreferrer">
              NFL game guide
            </a>{' '}
            · {fresh ? 'Coverage checked ' : 'Last checked '}
            <time datetime={watch.checkedAt} data-fmt="start">
              {watch.checkedAt}
            </time>
          </p>
        ) : live.sport === 'nfl' ? (
          <p>
            <a
              href="https://www.nfl.com/ways-to-watch"
              target="_blank"
              rel="noopener noreferrer"
            >
              Check NFL coverage for 60640
            </a>
          </p>
        ) : null}
      </div>
    </details>
  );
}

/** A series leg's series: wins so far and the game in progress or next. */
export function SeriesScore(props: {
  series: SeriesView;
  timeZone: string;
  now: Date;
}) {
  const s = props.series;
  const g = s.nextGame;
  const lead = (side: 'home' | 'away') =>
    s[side].wins > s[side === 'home' ? 'away' : 'home'].wins;
  return (
    <div class="scoreboard series-score">
      <div class="game-meta">
        <div class={`game-clock ${g?.status ?? s.status}`}>
          {s.title ? `${s.title} · ` : ''}
          {s.summary}
        </div>
      </div>
      {(['away', 'home'] as const).map((side) => (
        <div class={`team${s.status !== 'pre' && lead(side) ? ' lead' : ''}`}>
          <span class="name">{s[side].name}</span>
          <span class="score">{s[side].wins}</span>
        </div>
      ))}
      {g ? (
        <div class="sit">
          Game {g.number} at {g.host}
          {g.status === 'pre' ? (
            <>
              {' · '}
              <time datetime={g.startTime} data-fmt="start">
                {timeLabel(g.startTime, 'start', props.timeZone, props.now)}
              </time>
            </>
          ) : (
            ` · ${g.status === 'in' ? 'Live' : 'Final'}${g.score ? ` ${g.score}` : ''}${g.detail ? ` · ${g.detail}` : ''}`
          )}
        </div>
      ) : null}
      {s.status !== 'final' ? (
        <Freshness
          at={s.fetchedAt}
          now={props.now}
          live={g?.status === 'in'}
          staleOnly
        />
      ) : null}
    </div>
  );
}
