import { describe, expect, it } from 'vitest';
import type { BetView } from '../src/tracker/views.js';
import { record, settledByDay, validTimeZone } from '../src/web/daily.js';

const bet = (
  id: number,
  status: BetView['status'],
  stake: number,
  value: number,
  settledAt: string | null
) =>
  ({
    id,
    status,
    stake,
    settledAt,
    now: { source: 'model', pWin: 0, pPush: 0, value, ev: value - stake },
  }) as unknown as BetView;

// now = 2026-10-04 11:00 CDT. One bet settled 23:30 CDT on Oct 3, which is
// 05:30 on Oct 4 in Lisbon: "Yesterday" in Chicago, "Today" in Lisbon.
const NOW = new Date('2026-10-04T16:00:00Z');
const BETS = [
  bet(1, 'won', 10, 26, '2026-10-04T15:00:00Z'),
  bet(2, 'lost', 10, 0, '2026-10-04T04:30:00Z'),
  bet(3, 'push', 5, 5, '2026-10-04T14:00:00Z'),
  bet(4, 'won', 10, 34, '2026-10-01T02:00:00Z'),
  bet(5, 'open', 10, 12, null),
  bet(6, 'void', 10, 10, null),
];

describe('settledByDay', () => {
  it("groups by the viewer's day, newest first, with each day's money", () => {
    const g = settledByDay(BETS, 'America/Chicago', NOW);
    expect(g.map((x) => x.label)).toEqual([
      'Today',
      'Yesterday',
      'Wed, Sep 30',
      'Settle time unknown',
    ]);
    const today = g[0]!;
    expect(today.bets.map((b) => b.id)).toEqual([1, 3]); // newest first
    expect(today).toMatchObject({
      won: 1,
      lost: 0,
      push: 1,
      staked: 15,
      returned: 31,
      net: 16,
    });
    expect(g[1]).toMatchObject({ day: '2026-10-03', lost: 1, net: -10 });
    // Open bets are not settled results.
    expect(g.flatMap((x) => x.bets).some((b) => b.id === 5)).toBe(false);
  });

  it('a late-night result moves to today for a viewer further east', () => {
    const g = settledByDay(BETS, 'Europe/Lisbon', NOW);
    expect(g[0]!.label).toBe('Today');
    expect(g[0]!.bets.map((b) => b.id).sort()).toEqual([1, 2, 3]);
    // won 16 + lost -10 + push 0
    expect(g[0]!.net).toBe(6);
    expect(record(g[0]!)).toBe('1W 1L 1P');
  });

  it('records omit pushes when there are none', () => {
    expect(record({ won: 2, lost: 1, push: 0 })).toBe('2W 1L');
  });
});

describe('validTimeZone', () => {
  it.each([
    ['America/New_York', 'America/New_York'],
    ['Europe/Lisbon', 'Europe/Lisbon'],
    ['Mars/Olympus_Mons', 'America/Chicago'],
    ['', 'America/Chicago'],
    [undefined, 'America/Chicago'],
    ['x'.repeat(100), 'America/Chicago'],
  ])('%s -> %s', (tz, expected) => {
    expect(validTimeZone(tz, 'America/Chicago')).toBe(expected);
  });
});
