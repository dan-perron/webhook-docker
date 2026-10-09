import type { Side, Sport } from '../domain/types.js';
import type { GameState } from '../gamestate/types.js';

// Score alerts are pure functions of (previous state, new state): a game
// starting, the lead changing hands, a close game late, and the final. Each
// alert carries a dedupe key so a restart or re-poll never sends it twice.

export const ALERT_KINDS = ['start', 'lead', 'close', 'final'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export interface Alert {
  kind: AlertKind;
  key: string;
  title: string;
  body: string;
}

/**
 * "Close late": at most `margin` points apart with at most `fraction` of
 * regulation left (or in overtime). Football and basketball: last 7.5 / 5
 * minutes; hockey: last 10 minutes; MLB: 8th inning on; soccer: 75th minute
 * on. Volleyball instead alerts when a match goes to a fifth set.
 */
export const CLOSE_LATE: Partial<
  Record<Sport, { fraction: number; margin: number }>
> = {
  nfl: { fraction: 0.125, margin: 8 },
  ncaaf: { fraction: 0.125, margin: 8 },
  wnba: { fraction: 0.125, margin: 6 },
  nhl: { fraction: 1 / 6, margin: 1 },
  mlb: { fraction: 2 / 9, margin: 2 },
  soccer: { fraction: 1 / 6, margin: 1 },
  ncaab: { fraction: 0.125, margin: 6 },
  ncaamh: { fraction: 1 / 6, margin: 1 },
  ncaawh: { fraction: 1 / 6, margin: 1 },
};

export const SPORT_ICON: Record<Sport, string> = {
  nfl: '🏈',
  ncaaf: '🏈',
  mlb: '⚾',
  nhl: '🏒',
  wnba: '🏀',
  soccer: '⚽',
  mma: '🥊',
  ncaab: '🏀',
  ncaamh: '🏒',
  ncaawh: '🏒',
  ncaawvb: '🏐',
};

export function leader(s: GameState): Side | null {
  if (s.home.score > s.away.score) return 'home';
  if (s.away.score > s.home.score) return 'away';
  return null;
}

/** "Packers @ Bears" (fights: "Jones v Miocic"). */
export function matchup(s: GameState): string {
  return s.sport === 'mma'
    ? `${s.home.name} v ${s.away.name}`
    : `${s.away.name} @ ${s.home.name}`;
}

/** "Bears 21–17" (leader first) or "Tied 14–14". */
export function scoreline(s: GameState): string {
  const lead = leader(s);
  if (!lead) return `Tied ${s.home.score}–${s.away.score}`;
  const [w, l] = lead === 'home' ? [s.home, s.away] : [s.away, s.home];
  return `${w.name} ${w.score}–${l.score}`;
}

export interface Detected {
  alerts: Alert[];
  /** The side leading now, or the last leader through a tie. */
  lastLeader: Side | null;
}

/**
 * Alerts for one poll. `prev` is null on a game's first fetch (just added):
 * that only records the leader, so adding a live game doesn't alert.
 * `lastLeader` is the last side seen leading (ties don't reset it), so
 * 1-0, 1-1, 1-2 is a lead change.
 */
export function detectAlerts(
  prev: GameState | null,
  next: GameState,
  lastLeader: Side | null
): Detected {
  const scored = next.sport !== 'mma';
  const nowLeader = scored ? (leader(next) ?? lastLeader) : null;
  const alerts: Alert[] = [];
  if (!prev) return { alerts, lastLeader: nowLeader };

  const icon = SPORT_ICON[next.sport];
  const where = `${matchup(next)} · ${next.detail}`;

  if (next.status === 'final' && prev.status !== 'final') {
    alerts.push(
      next.cancelled
        ? {
            kind: 'final',
            key: 'final',
            title: `${icon} ${next.detail}: ${matchup(next)}`,
            body: matchup(next),
          }
        : {
            kind: 'final',
            key: 'final',
            title: `${icon} Final: ${scored ? scoreline(next) : matchup(next)}`,
            body: where,
          }
    );
    return { alerts, lastLeader: nowLeader };
  }
  if (next.status !== 'in') return { alerts, lastLeader: nowLeader };

  if (prev.status === 'pre') {
    alerts.push({
      kind: 'start',
      key: 'start',
      title: `${icon} Started: ${matchup(next)}`,
      body: next.detail,
    });
  }
  if (!scored) return { alerts, lastLeader: nowLeader };

  const lead = leader(next);
  if (lead && lastLeader && lead !== lastLeader) {
    alerts.push({
      kind: 'lead',
      key: `lead:${next.away.score}-${next.home.score}`,
      title: `${icon} Lead change: ${scoreline(next)}`,
      body: where,
    });
  }
  if (next.situation?.kind === 'volleyball' && next.situation.set >= 5) {
    alerts.push({
      kind: 'close',
      key: 'close',
      title: `${icon} Fifth set: ${matchup(next)}`,
      body: next.detail,
    });
  }
  const close = CLOSE_LATE[next.sport];
  if (
    close &&
    next.fractionRemaining <= close.fraction + 1e-9 &&
    Math.abs(next.home.score - next.away.score) <= close.margin
  ) {
    alerts.push({
      kind: 'close',
      key: 'close',
      title: `${icon} Close late: ${scoreline(next)}`,
      body: where,
    });
  }
  return { alerts, lastLeader: nowLeader };
}

/** Minutes after local midnight, or null for a malformed "HH:MM". */
const minutes = (hhmm: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
};

/** Whether `now` falls in "HH:MM-HH:MM" (may wrap midnight) in `timeZone`. */
export function inQuietHours(
  spec: string,
  now: Date,
  timeZone: string
): boolean {
  const [a, b] = spec.split('-');
  if (!a || !b) return false;
  const start = minutes(a);
  const end = minutes(b);
  if (start == null || end == null || start === end) return false;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) =>
    Number(parts.find((p) => p.type === t)?.value ?? 0);
  const t = get('hour') * 60 + get('minute');
  return start < end ? t >= start && t < end : t >= start || t < end;
}
