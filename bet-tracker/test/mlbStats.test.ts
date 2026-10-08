import { describe, expect, it } from 'vitest';
import {
  MlbStatsProvider,
  parseSchedule,
  situationFromLinescore,
  type MlbSchedule,
} from '../src/gamestate/mlbStats.js';
import { fakeFetcher, fixture } from './helpers/fixtures.js';

const runner = { id: 1 };

describe('situationFromLinescore', () => {
  it('Top 3rd, 1 out, runners on 1st and 3rd', () => {
    expect(
      situationFromLinescore({
        currentInning: 3,
        inningState: 'Top',
        outs: 1,
        offense: { first: runner, third: runner },
      })
    ).toEqual({
      kind: 'baseball',
      inning: 3,
      half: 'top',
      outs: 1,
      first: true,
      second: false,
      third: true,
      scheduledInnings: 9,
      extraInningRunner: true,
    });
  });

  it('Middle 8th becomes bottom 8th, 0 out, bases empty', () => {
    expect(
      situationFromLinescore({
        currentInning: 8,
        inningState: 'Middle',
        outs: 3,
        offense: { first: runner },
      })
    ).toMatchObject({ inning: 8, half: 'bottom', outs: 0, first: false });
  });

  it('End 9th becomes top 10th', () => {
    expect(
      situationFromLinescore({ currentInning: 9, inningState: 'End', outs: 3 })
    ).toMatchObject({ inning: 10, half: 'top', outs: 0 });
  });

  it('Bottom with 3 outs not yet flipped rolls to the next top', () => {
    expect(
      situationFromLinescore({
        currentInning: 6,
        inningState: 'Bottom',
        outs: 3,
        offense: { second: runner },
      })
    ).toMatchObject({ inning: 7, half: 'top', outs: 0, second: false });
  });
});

describe('parseSchedule (recorded CWS @ CLE, ALDS G1)', () => {
  const sched = fixture<MlbSchedule>('mlb/schedule-20261003.json');
  const states = parseSchedule(sched);

  it('live game: Top 8th, 1 out, CWS 3 CLE 0', () => {
    const s = states.find((x) => x.eventId === 'mlb:849829')!;
    expect(s.status).toBe('in');
    expect(s.away).toMatchObject({ name: 'Chicago White Sox', score: 3 });
    expect(s.home).toMatchObject({ name: 'Cleveland Guardians', score: 0 });
    expect(s.situation).toMatchObject({
      inning: 8,
      half: 'top',
      outs: 1,
      // gameType D (division series): no extra-innings runner
      extraInningRunner: false,
    });
    expect(s.detail).toBe('Top 8th, 1 out');
    // (14 + 1/3) of 18 half-innings done
    expect(s.fractionRemaining).toBeCloseTo(1 - (14 + 1 / 3) / 18, 10);
  });

  it('preview games are pre', () => {
    const pre = states.filter((x) => x.eventId !== 'mlb:849829');
    expect(pre).toHaveLength(3);
    expect(
      pre.every((x) => x.status === 'pre' && x.fractionRemaining === 1)
    ).toBe(true);
  });
});

describe('MlbStatsProvider', () => {
  it('polls all games in one batched schedule call', async () => {
    const { fetcher, requested } = fakeFetcher({
      'gamePks=849829,849828': 'mlb/schedule-20261003.json',
    });
    const refs = ['849829', '849828'].map((pk) => ({
      id: `mlb:${pk}`,
      sport: 'mlb' as const,
      league: 'mlb',
      startTime: '2026-10-03T17:00:00.000Z',
    }));
    const states = await new MlbStatsProvider(fetcher).getStates(refs);
    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain('hydrate=linescore');
    expect(states.get('mlb:849829')?.status).toBe('in');
  });

  it('lists events for a local date (SD @ MIL 7:30 PM CT counts as 10/3)', async () => {
    const { fetcher } = fakeFetcher({
      'schedule?sportId=1&date=2026-10-03': 'mlb/schedule-20261003.json',
    });
    const events = await new MlbStatsProvider(fetcher).listEvents(
      'mlb',
      '2026-10-03'
    );
    expect(events.map((e) => e.id).sort()).toEqual(
      ['mlb:849828', 'mlb:849829', 'mlb:849830', 'mlb:849835'].sort()
    );
    const sdMil = events.find((e) => e.id === 'mlb:849830')!;
    expect(sdMil.home.name).toBe('Milwaukee Brewers');
  });
});

describe('parseSchedule (recorded inning break)', () => {
  it('Middle 8th with 3 outs is bottom 8th, 0 out, bases empty', () => {
    const [s] = parseSchedule(
      fixture<MlbSchedule>('mlb/schedule-849829-mid8.json')
    );
    expect(s!.situation).toMatchObject({
      inning: 8,
      half: 'bottom',
      outs: 0,
      first: false,
      second: false,
      third: false,
    });
    expect(s!.detail).toBe('Mid 8th');
    // 15 of 18 half-innings done
    expect(s!.fractionRemaining).toBeCloseTo(3 / 18, 10);
  });
});

describe('parseSchedule (recorded status edge cases)', () => {
  it('"Warmup" is abstractly Live but has not started', () => {
    const [s] = parseSchedule(
      fixture<MlbSchedule>('mlb/schedule-849828-warmup.json')
    );
    expect(s).toMatchObject({
      status: 'pre',
      fractionRemaining: 1,
      situation: null,
      detail: 'Warmup',
    });
  });

  it('"Game Over": CWS 3 @ CLE 0 is final, away wins', () => {
    const [s] = parseSchedule(
      fixture<MlbSchedule>('mlb/schedule-849829-gameover.json')
    );
    expect(s).toMatchObject({
      status: 'final',
      winner: 'away',
      detail: 'Final',
      fractionRemaining: 0,
    });
    expect(s!.away.score).toBe(3);
    // gameInfo: first pitch 17:08Z + 169 min game + 0 min delay = 19:57Z.
    expect(s!.endTime).toBe('2026-10-03T19:57:00.000Z');
  });
});
