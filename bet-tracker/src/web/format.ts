import type { BetStatus } from '../domain/types.js';
import type { LegView, LiveView } from '../tracker/views.js';

const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
});

export const usd = (n: number) => money.format(n);

/** "+$11.41" / "−$0.39" (true minus sign). */
export const signedUsd = (n: number) =>
  `${n >= 0 ? '+' : '−'}${money.format(Math.abs(n))}`;

export const american = (n: number) => (n > 0 ? `+${n}` : `${n}`);

export const pct = (p: number | null) =>
  p == null ? '–' : `${(p * 100).toFixed(1)}%`;

export type TimeKind = 'time' | 'start';

/**
 * Text for a <time> element. The server renders it in the app's zone as a
 * fallback; public/app.js re-renders the same format in the device's zone.
 * 'time' = "8:44 PM"; 'start' = "1:45 PM" today, "Sun 1:45 PM" within a
 * week, else "Oct 12, 1:45 PM".
 */
export function timeLabel(
  iso: string,
  kind: TimeKind,
  timeZone: string,
  now: Date = new Date()
): string {
  const d = new Date(iso);
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
  if (kind === 'time') return time;
  const day = (x: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone }).format(x);
  if (day(d) === day(now)) return time;
  const days = (d.getTime() - now.getTime()) / 86_400_000;
  const date = new Intl.DateTimeFormat(
    'en-US',
    days > -1 && days < 6
      ? { timeZone, weekday: 'short' }
      : { timeZone, month: 'short', day: 'numeric' }
  ).format(d);
  return days > -1 && days < 6 ? `${date} ${time}` : `${date}, ${time}`;
}

export type Tone = 'good' | 'warn' | 'bad' | 'won' | 'lost' | 'push' | 'idle';

/**
 * Status for a leg or bet: settled results first, then "not started" for
 * games that haven't begun (a pregame longshot isn't "in trouble"), then the
 * live probability bands (on track >= 0.7, live 0.3-0.7, in trouble < 0.3).
 */
export function tone(
  status: BetStatus,
  p: number | null,
  started = true
): { tone: Tone; icon: string; label: string } {
  switch (status) {
    case 'won':
      return { tone: 'won', icon: '🏆', label: 'Won' };
    case 'lost':
      return { tone: 'lost', icon: '✖', label: 'Lost' };
    case 'push':
      return { tone: 'push', icon: '↺', label: 'Push' };
    case 'void':
      return { tone: 'push', icon: '⊘', label: 'Void' };
  }
  if (p == null) return { tone: 'idle', icon: '…', label: 'Pending' };
  if (!started) return { tone: 'idle', icon: '🕒', label: 'Not started' };
  if (p >= 0.7) return { tone: 'good', icon: '✅', label: 'On track' };
  if (p >= 0.3) return { tone: 'warn', icon: '⚠️', label: 'Live' };
  return { tone: 'bad', icon: '❌', label: 'In trouble' };
}

const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
};

/** One line of game situation, e.g. "UCF ball · 4th & 6 at UCF 29". */
export function situationText(live: LiveView): string | null {
  const s = live.situation;
  if (!s || live.status !== 'in') return null;
  switch (s.kind) {
    case 'football': {
      if (!s.possession) return null;
      const team = s.possession === 'home' ? live.home : live.away;
      const who = `${team.abbr ?? team.name} ball`;
      return s.text ? `${who} · ${s.text}` : who;
    }
    case 'baseball': {
      const bases = [
        s.first && '1st',
        s.second && '2nd',
        s.third && '3rd',
      ].filter(Boolean);
      return [
        `${s.half === 'top' ? 'Top' : 'Bot'} ${ordinal(s.inning)}`,
        `${s.outs} out`,
        bases.length ? `on ${bases.join(', ')}` : 'bases empty',
      ].join(' · ');
    }
    case 'soccer':
      return `${s.minute}'`;
    default:
      // Hockey/basketball: the period and clock are already in the detail.
      return null;
  }
}

/** A provider note worth showing before a game starts. */
export function pregameNote(detail: string): string | null {
  return /delay|postpon|suspend|cancel/i.test(detail) ? detail : null;
}

/**
 * Short leg line: score and game clock (the situation line adds detail).
 * Null for a game that hasn't started: the page shows its start time.
 */
export function legStatusLine(l: LegView): string | null {
  if (l.match.status === 'needs_confirmation')
    return 'Needs event confirmation';
  if (l.match.status === 'unmatched') return 'Not matched to an event yet';
  if (!l.live) return 'Waiting for first update';
  const { live } = l;
  if (live.status === 'pre') return null;
  if (!live.score) return live.detail;
  // Baseball's situation line already carries the inning and outs.
  if (live.status === 'in' && live.situation?.kind === 'baseball')
    return live.score;
  return `${live.score} · ${live.detail}`;
}
