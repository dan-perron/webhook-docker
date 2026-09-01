import type { EventDoc } from '../db/types.js';
import type { Clock } from '../util/clock.js';
import { allMinutes, dateLabel } from '../util/slots.js';
import { url } from '../util/url.js';

const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Which weekdays this poll actually contains, as the VIEWER sees them — a
 * column is labelled with its local date, so someone far enough east sees the
 * poll's Monday as their Tuesday and must be able to say "Tuesday".
 */
function weekdaysPresent(ev: EventDoc, clock: Clock): number[] {
  const seen = new Set<number>();
  for (const date of ev.dates) {
    seen.add(new Date(`${clock.columnDate(date)}T00:00:00`).getDay());
  }
  return [...seen].sort((a, b) => a - b);
}

interface Props {
  ev: EventDoc;
  clock: Clock;
}

/**
 * The fast path. Painting a whole week cell by cell is a lot of touching, and
 * on a phone it is fiddly touching — so most people should never need to drag
 * at all: set a band of hours, pick the weekdays, hit Free. The grid below is
 * then only for exceptions.
 *
 * Plain form controls on purpose. Selects and chips are far easier to hit than
 * 30px squares, and this whole panel posts and works with no JavaScript;
 * grid.js only intercepts it to skip the page reload.
 */
export function QuickFill({ ev, clock }: Props) {
  const minutes = allMinutes(ev);
  const ends = [...minutes.slice(1), ev.endMinute];
  const dows = weekdaysPresent(ev, clock);

  return (
    <section class="card quick">
      <h2 class="section-title">Fill in a chunk at a time</h2>

      <form
        method="post"
        action={url(`/e/${ev.slug}/bulk`)}
        class="quick__form"
        id="quickfill"
      >
        <div class="quick__row">
          <label>
            From
            <select name="fromMinute">
              {minutes.map((m) => (
                <option value={String(m)} selected={m === ev.startMinute}>
                  {clock.label(ev.dates[0], m)}
                </option>
              ))}
            </select>
          </label>
          <label>
            To
            <select name="toMinute">
              {ends.map((m) => (
                <option value={String(m)} selected={m === ev.endMinute}>
                  {clock.label(ev.dates[0], m)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <fieldset class="quick__days">
          <legend>on</legend>
          {dows.map((d) => (
            <label class="chip">
              <input type="checkbox" name="dow" value={String(d)} checked />
              <span>{DOW_SHORT[d]}</span>
            </label>
          ))}
        </fieldset>

        <div class="quick__actions">
          <button type="submit" name="action" value="yes" class="act act--yes">
            I&apos;m free
          </button>
          <button
            type="submit"
            name="action"
            value="ifNeeded"
            class="act act--if"
          >
            If needed
          </button>
          <button
            type="submit"
            name="action"
            value="clear"
            class="act act--clear"
          >
            Clear
          </button>
        </div>
      </form>

      {ev.dates.length > 1 ? (
        <form
          method="post"
          action={url(`/e/${ev.slug}/copy-day`)}
          class="quick__copy"
          id="copyday"
        >
          <label class="quick__copyfrom">
            Copy
            <select name="from">
              {ev.dates.map((date) => (
                <option value={date}>
                  {dateLabel(clock.columnDate(date))}
                </option>
              ))}
            </select>
          </label>
          <fieldset class="quick__copyto">
            <legend>onto</legend>
            {ev.dates.map((date) => (
              <label class="chip chip--sm">
                <input type="checkbox" name="to" value={date} />
                <span>{dateLabel(clock.columnDate(date))}</span>
              </label>
            ))}
          </fieldset>
          <button type="submit">Copy</button>
        </form>
      ) : null}

      <p class="quick__hint">
        Set one day the way you want it, then copy it onto whichever other days
        match. Drag the top or bottom edge of a block on the grid to nudge when
        it starts or ends.
      </p>
    </section>
  );
}
