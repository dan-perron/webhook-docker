import type { EventDoc, Participant } from '../db/types.js';
import { dateLabel } from '../util/slots.js';
import type { Clock } from '../util/clock.js';
import { tzLabel } from '../util/clock.js';
import { rankProposals, type Proposal } from '../util/scoring.js';
import { url } from '../util/url.js';

// Must be whole multiples of the slot size, which is now an hour.
const DURATIONS = [60, 120, 180, 240];
const TOP = 5;
const MORE = 15;

function durationLabel(mins: number): string {
  if (mins < 60) return `${mins} min`;
  const h = mins / 60;
  return h === 1 ? '1 hour' : `${h} hours`;
}

/** "9:00 AM – 10:00 AM", or a start range when adjacent windows were merged. */
function whenLabel(p: Proposal, duration: number, clock: Clock) {
  const at = (minute: number) => clock.label(p.date, minute);
  if (p.startMinute === p.lastStartMinute) {
    return (
      <>
        {at(p.startMinute)} – {at(p.startMinute + duration)}
      </>
    );
  }
  return (
    <>
      start anytime between {at(p.startMinute)} and {at(p.lastStartMinute)}{' '}
      <span class="muted">(ends by {at(p.endMinute)})</span>
    </>
  );
}

function NameList({
  label,
  people,
  variant,
}: {
  label: string;
  people: Participant[];
  variant: string;
}) {
  if (!people.length) return null;
  return (
    <p class={`names names--${variant}`}>
      <span class="names__label">
        {label} ({people.length}):
      </span>{' '}
      {people.map((p) => p.name).join(', ')}
    </p>
  );
}

function ProposalRow({
  p,
  duration,
  total,
  rank,
  clock,
}: {
  p: Proposal;
  duration: number;
  total: number;
  rank: number;
  clock: Clock;
}) {
  const can = p.yes.length + p.ifNeeded.length;
  return (
    <li class={`proposal ${p.no.length === 0 ? 'proposal--all' : ''}`}>
      <div class="proposal__head">
        <span class="proposal__rank">{rank}</span>
        <div>
          <div class="proposal__when">
            <strong>{dateLabel(clock.localDate(p.date, p.startMinute))}</strong>{' '}
            · {whenLabel(p, duration, clock)}
          </div>
          <div class="proposal__count">
            <strong>
              {can} of {total}
            </strong>{' '}
            can make it
            {p.ifNeeded.length ? (
              <span class="muted">
                {' '}
                — {p.yes.length} free, {p.ifNeeded.length} if needed
              </span>
            ) : null}
          </div>
        </div>
      </div>
      <NameList label="Free" people={p.yes} variant="yes" />
      <NameList label="If needed" people={p.ifNeeded} variant="if" />
      <NameList label="Can't make it" people={p.no} variant="no" />
    </li>
  );
}

interface BestPanelProps {
  ev: EventDoc;
  /** Only people who have actually saved something. */
  responders: Participant[];
  /** Everyone who has never saved — reported separately, never as "can't". */
  waiting: Participant[];
  duration: number;
  clock: Clock;
}

export function BestPanel({
  ev,
  responders,
  waiting,
  duration,
  clock,
}: BestPanelProps) {
  const windowLength = ev.endMinute - ev.startMinute;
  const options = DURATIONS.filter((d) => d <= windowLength);
  if (!options.includes(duration)) options.push(duration);
  options.sort((a, b) => a - b);

  const ranked = rankProposals(ev, responders, duration);
  const top = ranked.slice(0, TOP);
  const rest = ranked.slice(TOP, MORE);
  const unanimous = top[0] && top[0].no.length === 0 && responders.length > 0;

  return (
    <section class="card" id="best">
      <div class="best__head">
        <h2 class="section-title">Best times</h2>
        <label class="durpick">
          Meeting length
          <select
            name="duration"
            hx-get={url(`/e/${ev.slug}/everyone`)}
            hx-target="#everyone"
            hx-swap="outerHTML"
            hx-trigger="change"
          >
            {options.map((d) => (
              <option value={String(d)} selected={d === duration}>
                {durationLabel(d)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {clock.same ? null : (
        <p class="fieldhint">Times shown in {tzLabel(clock.viewerTz)}.</p>
      )}
      {responders.length === 0 ? (
        <p class="empty">
          Proposals appear once somebody marks their availability.
        </p>
      ) : (
        <>
          {unanimous ? (
            <p class="callout">
              🎉 Works for everyone who has answered so far.
            </p>
          ) : null}
          <ol class="proposals">
            {top.map((p, i) => (
              <ProposalRow
                p={p}
                duration={duration}
                total={responders.length}
                rank={i + 1}
                clock={clock}
              />
            ))}
          </ol>
          {rest.length ? (
            <details class="more">
              <summary>Show {rest.length} more</summary>
              <ol class="proposals" start={TOP + 1}>
                {rest.map((p, i) => (
                  <ProposalRow
                    p={p}
                    duration={duration}
                    total={responders.length}
                    rank={TOP + i + 1}
                    clock={clock}
                  />
                ))}
              </ol>
            </details>
          ) : null}
          {waiting.length ? (
            <p class="names names--waiting">
              <span class="names__label">
                Hasn&apos;t responded ({waiting.length}):
              </span>{' '}
              {waiting.map((p) => p.name).join(', ')}
              <span class="muted">
                {' '}
                — not counted above, so these rankings may change.
              </span>
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
