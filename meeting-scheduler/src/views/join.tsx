import type { EventDoc, Participant } from '../db/types.js';
import { dateLabel } from '../util/slots.js';
import type { Clock } from '../util/clock.js';
import { tzLabel } from '../util/clock.js';
import { url } from '../util/url.js';

/**
 * Fills the join form's hidden timezone field with whatever zone the browser
 * thinks it is in, so the grid is already in the right times on first paint.
 * Falls back to the event's own zone if there is no JS.
 */
const DETECT_TZ = `try{var f=document.getElementById('tzfield');
if(f)f.value=Intl.DateTimeFormat().resolvedOptions().timeZone||'';}catch(e){}`;

export function EventSummary({ ev, clock }: { ev: EventDoc; clock?: Clock }) {
  const shown = clock ?? null;
  const first = ev.dates[0];
  const startLabel = shown
    ? shown.label(first, ev.startMinute)
    : `${Math.floor(ev.startMinute / 60)}:00`;
  const endLabel = shown
    ? shown.label(first, ev.endMinute)
    : `${Math.floor(ev.endMinute / 60)}:00`;
  const zone = shown ? shown.viewerTz : ev.timezone;

  return (
    <p class="eventmeta">
      {ev.dates
        .map((d) => dateLabel(shown ? shown.columnDate(d) : d))
        .join(' · ')}
      <br />
      {startLabel} – {endLabel} <span class="muted">({tzLabel(zone)})</span>
    </p>
  );
}

interface JoinProps {
  ev: EventDoc;
  participants: Participant[];
}

/**
 * Shown when the browser has no cookie for this event. The "I'm X" buttons are
 * what make filling in on someone else's behalf a four-tap operation instead of
 * a feature.
 */
export function JoinScreen({ ev, participants }: JoinProps) {
  return (
    <section class="card">
      <h1 class="pagetitle">{ev.title}</h1>
      <EventSummary ev={ev} />
      <h2 class="section-title">Who are you?</h2>
      <form method="post" action={url(`/e/${ev.slug}/join`)} class="joinform">
        <input
          name="name"
          type="text"
          placeholder="Your name"
          autocomplete="name"
          maxlength={60}
          autofocus
          required
        />
        <input type="hidden" name="timezone" id="tzfield" value="" />
        <button type="submit">Continue</button>
      </form>
      <script dangerouslySetInnerHTML={{ __html: DETECT_TZ }} />
      <p class="fieldhint">
        Times are set in {tzLabel(ev.timezone)}. You will see them in your own
        timezone, and you can change that later.
      </p>

      {participants.length ? (
        <>
          <p class="or">or pick yourself from the list</p>
          <div class="claimlist">
            {participants.map((p) => (
              <form method="post" action={url(`/e/${ev.slug}/join`)}>
                <button type="submit" name="claimId" value={String(p._id)}>
                  I&apos;m {p.name}
                  {p.respondedAt ? null : (
                    <span class="muted"> · no answer yet</span>
                  )}
                </button>
              </form>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

/**
 * Someone typed a name that already exists. Adopting silently is invisible
 * impersonation; rejecting outright is wrong too, because it is usually the
 * same person returning from a cleared cookie. So ask.
 */
export function CollisionScreen({
  ev,
  existing,
}: {
  ev: EventDoc;
  existing: Participant;
}) {
  return (
    <section class="card">
      <h1 class="pagetitle">{ev.title}</h1>
      <h2 class="section-title">
        Someone already answered as {existing.name}.
      </h2>
      <p>Is that you?</p>
      <div class="claimlist">
        <form method="post" action={url(`/e/${ev.slug}/join`)}>
          <button type="submit" name="claimId" value={String(existing._id)}>
            Yes, that&apos;s me — open my answers
          </button>
        </form>
        <form method="post" action={url(`/e/${ev.slug}/join`)}>
          <input type="hidden" name="name" value={existing.name} />
          <input type="hidden" name="forceNew" value="1" />
          <input type="hidden" name="timezone" id="tzfield" value="" />
          <button type="submit" class="secondary">
            No, I&apos;m a different {existing.name}
          </button>
        </form>
      </div>
      <script dangerouslySetInnerHTML={{ __html: DETECT_TZ }} />
    </section>
  );
}
