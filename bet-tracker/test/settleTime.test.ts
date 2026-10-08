import { describe, expect, it } from 'vitest';
import {
  betSettledAt,
  eventFinalAt,
  GAME_MINUTES,
} from '../src/domain/settleTime.js';

const NOW = new Date('2026-10-07T05:23:00.000Z');
const final = (over: { endTime?: string | null; fetchedAt?: string } = {}) => ({
  status: 'final' as const,
  cancelled: false,
  endTime: null,
  fetchedAt: NOW.toISOString(),
  ...over,
});

describe('eventFinalAt', () => {
  it('uses the provider end time when there is one', () => {
    expect(
      eventFinalAt(
        'mlb',
        '2026-10-03T17:00:00Z',
        final({ endTime: '2026-10-03T19:57:00.000Z' }),
        NOW
      )
    ).toBe('2026-10-03T19:57:00.000Z');
  });

  it('otherwise start + the sport estimate (NFL 13:00Z + 195 min = 16:15Z)', () => {
    expect(GAME_MINUTES.nfl).toBe(195);
    expect(eventFinalAt('nfl', '2026-10-04T13:00:00Z', final(), NOW)).toBe(
      '2026-10-04T16:15:00.000Z'
    );
  });

  it('never later than when it was seen final', () => {
    // Estimate 16:15Z, but the poll at 15:58Z already showed it final.
    expect(
      eventFinalAt(
        'nfl',
        '2026-10-04T13:00:00Z',
        final({ fetchedAt: '2026-10-04T15:58:00.000Z' }),
        NOW
      )
    ).toBe('2026-10-04T15:58:00.000Z');
  });

  it('a cancelled event ends at its start', () => {
    expect(
      eventFinalAt(
        'mlb',
        '2026-10-03T17:00:00Z',
        { ...final(), cancelled: true },
        NOW
      )
    ).toBe('2026-10-03T17:00:00.000Z');
  });
});

describe('betSettledAt', () => {
  const T1 = '2026-10-04T16:15:00.000Z';
  const T2 = '2026-10-04T19:20:00.000Z';
  const T3 = '2026-10-04T23:40:00.000Z';

  it('single bet: its game’s final time', () => {
    expect(betSettledAt([{ status: 'won', finalAt: T1 }])).toBe(T1);
    expect(betSettledAt([{ status: 'lost', finalAt: T2 }])).toBe(T2);
  });

  it('parlay won: the latest leg', () => {
    expect(
      betSettledAt([
        { status: 'won', finalAt: T2 },
        { status: 'won', finalAt: T3 },
        { status: 'push', finalAt: T1 },
      ])
    ).toBe(T3);
  });

  it('parlay lost early: the first losing leg, other legs still open', () => {
    expect(
      betSettledAt([
        { status: 'won', finalAt: T1 },
        { status: 'lost', finalAt: T3 },
        { status: 'lost', finalAt: T2 },
        { status: 'open', finalAt: null },
      ])
    ).toBe(T2);
  });

  it('open, or a deciding leg without a final time: null', () => {
    expect(
      betSettledAt([
        { status: 'won', finalAt: T1 },
        { status: 'open', finalAt: null },
      ])
    ).toBeNull();
    expect(
      betSettledAt([
        { status: 'won', finalAt: T1 },
        { status: 'won', finalAt: null },
      ])
    ).toBeNull();
  });
});
