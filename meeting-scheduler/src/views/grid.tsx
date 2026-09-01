import type { EventDoc, Participant, SlotState } from '../db/types.js';
import {
  allMinutes,
  dateHeaderParts,
  longDateLabel,
  slotKey,
} from '../util/slots.js';
import type { Clock } from '../util/clock.js';
import { tzLabel } from '../util/clock.js';
import { url } from '../util/url.js';
import { JsonScript } from './layout.js';
import { BestPanel } from './best.js';

const pad = (n: number) => String(n).padStart(2, '0');
const timeFillKey = (m: number) =>
  `time:${pad(Math.floor(m / 60))}${pad(m % 60)}`;

const STATE_WORD: Record<string, string> = {
  yes: 'free',
  ifNeeded: 'if needed',
  none: 'not available',
};

/**
 * Row labels come from the first date. When a viewer is far enough from the
 * event's zone that a row lands on the next local day, mark it — otherwise
 * "1:00" under a Monday column silently means Tuesday.
 */
function rowLabel(ev: EventDoc, clock: Clock, minute: number) {
  return {
    text: clock.short(ev.dates[0], minute),
    nextDay: clock.offset(ev.dates[0], minute) - clock.headerOffset > 0,
  };
}

/** Full spoken description of one cell, always in the viewer's own zone. */
function cellLabel(clock: Clock, date: string, minute: number) {
  // localDate, not columnDate — a late row can land on the next local day.
  return `${longDateLabel(clock.localDate(date, minute))} at ${clock.label(date, minute)}`;
}

/** Column heading — the viewer's local date for that column's first slot. */
function ColumnHead({ clock, date }: { clock: Clock; date: string }) {
  const { dow, day } = dateHeaderParts(clock.columnDate(date));
  return (
    <>
      <span class="grid__dow">{dow}</span>
      <span class="grid__day">{day}</span>
    </>
  );
}

export function BrushPicker() {
  return (
    <fieldset class="brush">
      <legend class="brush__legend">Painting</legend>
      <label class="brush__opt brush__opt--yes">
        <input type="radio" name="brush" value="yes" checked />
        <span>Free</span>
      </label>
      <label class="brush__opt brush__opt--if">
        <input type="radio" name="brush" value="ifNeeded" />
        <span>If needed</span>
      </label>
      <p class="brush__hint">
        Drag down a day to block out a stretch of time, then drag the handle at
        either end to change when it starts or stops. Tap a single hour to
        toggle it, or a day or time label to fill that whole row or column.
      </p>
    </fieldset>
  );
}

interface MyGridProps {
  ev: EventDoc;
  me: Participant;
  clock: Clock;
}

/**
 * The interactive grid. Server-rendered once and never swapped — that is what
 * makes the "don't clobber the cells under the user's finger" problem vanish
 * rather than need solving.
 *
 * Every cell is a real submit button, so the whole thing works with JS off.
 */
export function MyGrid({ ev, me, clock }: MyGridProps) {
  const minutes = allMinutes(ev);
  return (
    <form
      id="gridwrap"
      class="card"
      method="post"
      action={url(`/e/${ev.slug}/slots-form`)}
    >
      <h2 class="section-title">Your availability</h2>
      <BrushPicker />
      <div class="grid-scroll">
        <table class="grid grid--mine" id="mygrid">
          <thead>
            <tr>
              <th class="grid__corner" scope="col">
                <span class="visually-hidden">Time</span>
              </th>
              {ev.dates.map((date) => (
                <th scope="col" class="grid__dayhead">
                  <button
                    type="submit"
                    name="fill"
                    value={`date:${date}`}
                    class="fillbtn"
                    data-fill={`date:${date}`}
                    title={`Fill all of ${longDateLabel(clock.columnDate(date))}`}
                  >
                    <ColumnHead clock={clock} date={date} />
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {minutes.map((m) => {
              const row = rowLabel(ev, clock, m);
              return (
                <tr>
                  <th scope="row" class="grid__timehead">
                    <button
                      type="submit"
                      name="fill"
                      value={timeFillKey(m)}
                      class="fillbtn"
                      data-fill={timeFillKey(m)}
                      title={`Fill ${clock.label(ev.dates[0], m)} on every day`}
                    >
                      {row.text}
                      {row.nextDay ? <sup class="grid__next">+1</sup> : null}
                    </button>
                  </th>
                  {ev.dates.map((date) => {
                    const key = slotKey(date, m);
                    const state: SlotState | 'none' = me.slots?.[key] ?? 'none';
                    const label = cellLabel(clock, date, m);
                    return (
                      <td class="grid__cellwrap">
                        <button
                          type="submit"
                          name="toggle"
                          value={key}
                          class="cell"
                          data-slot={key}
                          data-state={state}
                          data-label={label}
                          aria-label={`${label}, ${STATE_WORD[state]}`}
                        >
                          <span aria-hidden="true"></span>
                        </button>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {clock.rowsUniform ? null : (
        <p class="fieldhint">
          The clocks change during this range, so a row can land at slightly
          different local times on different days. Each square&apos;s exact
          local time is in its tooltip.
        </p>
      )}
      <p class="savestatus" id="savestatus" aria-live="polite"></p>
    </form>
  );
}

interface EveryoneProps {
  ev: EventDoc;
  participants: Participant[];
  duration: number;
  clock: Clock;
}

/**
 * Read-only group view: heatmap, response tally, and the ranked proposals.
 * Re-rendered wholesale after every save and on a poll — it is the ONLY thing
 * that gets swapped.
 */
export function Everyone({ ev, participants, duration, clock }: EveryoneProps) {
  const minutes = allMinutes(ev);
  const responders = participants.filter((p) => p.respondedAt);
  const waiting = participants.filter((p) => !p.respondedAt);
  const names = Object.fromEntries(
    participants.map((p) => [String(p._id), p.name])
  );

  return (
    <section
      id="everyone"
      class="stack"
      hx-get={url(`/e/${ev.slug}/everyone?duration=${duration}`)}
      hx-trigger="every 15s [!window.__painting]"
      hx-swap="outerHTML"
    >
      <JsonScript id="names-data" value={names} />
      <section class="card">
        <h2 class="section-title">Everyone</h2>
        <p class="tally">
          <strong>
            {responders.length} of {participants.length}
          </strong>{' '}
          {participants.length === 1 ? 'person has' : 'people have'} filled this
          in.
          {waiting.length ? (
            <>
              {' '}
              Still waiting on{' '}
              <span class="waiting">
                {waiting.map((p) => p.name).join(', ')}
              </span>
              .
            </>
          ) : null}
        </p>

        {responders.length === 0 ? (
          <p class="empty">
            Nobody has marked any times yet. Paint your availability above and
            it will show up here.
          </p>
        ) : (
          <>
            <div class="grid-scroll">
              <table class="grid grid--heat" id="heatgrid">
                <thead>
                  <tr>
                    <th class="grid__corner" scope="col">
                      <span class="visually-hidden">Time</span>
                    </th>
                    {ev.dates.map((date) => (
                      <th scope="col" class="grid__dayhead">
                        <ColumnHead clock={clock} date={date} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {minutes.map((m) => {
                    const row = rowLabel(ev, clock, m);
                    return (
                      <tr>
                        <th scope="row" class="grid__timehead">
                          {row.text}
                          {row.nextDay ? (
                            <sup class="grid__next">+1</sup>
                          ) : null}
                        </th>
                        {ev.dates.map((date) => {
                          const key = slotKey(date, m);
                          const yes = responders.filter(
                            (p) => p.slots?.[key] === 'yes'
                          );
                          const iff = responders.filter(
                            (p) => p.slots?.[key] === 'ifNeeded'
                          );
                          const can = yes.length + iff.length;
                          const frac = can / responders.length;
                          const label = cellLabel(clock, date, m);
                          return (
                            <td class="grid__cellwrap">
                              <button
                                type="button"
                                class="heat"
                                data-heat={key}
                                data-yes={yes
                                  .map((p) => String(p._id))
                                  .join(',')}
                                data-if={iff
                                  .map((p) => String(p._id))
                                  .join(',')}
                                data-label={label}
                                data-striped={iff.length ? '1' : '0'}
                                style={`--f:${frac.toFixed(3)}`}
                                aria-label={`${label}: ${can} of ${responders.length} available`}
                              >
                                {can > 0 ? can : ''}
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p class="heatdetail" id="heatdetail" aria-live="polite">
              Tap a square to see who is free then.
            </p>
            {clock.same ? null : (
              <p class="fieldhint">Shown in {tzLabel(clock.viewerTz)}.</p>
            )}
          </>
        )}
      </section>

      <BestPanel
        ev={ev}
        responders={responders}
        waiting={waiting}
        duration={duration}
        clock={clock}
      />
    </section>
  );
}
