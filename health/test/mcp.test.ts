import { beforeAll, describe, expect, it } from 'vitest';
import { mcpClient, setup } from './helpers/app.js';
import { testDb } from './helpers/mongo.js';

type Env = Awaited<ReturnType<typeof setup>> & ReturnType<typeof mcpClient>;

async function fresh(): Promise<Env> {
  const env = await setup(await testDb());
  return { ...env, ...mcpClient(env.app) };
}

const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

describe('mcp: tools and instructions', () => {
  it('lists the health_ tools and the instructions', async () => {
    const { rpc } = await fresh();
    const init = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 't', version: '1' },
    });
    const ib = (await init.json()) as { result: { instructions: string } };
    expect(ib.result.instructions).toMatch(/one experiment active at a time/i);
    expect(ib.result.instructions).toMatch(/1-3 days/);
    expect(ib.result.instructions).toMatch(/single flare/);
    const res = await rpc('tools/list', {});
    const body = (await res.json()) as {
      result: { tools: { name: string }[] };
    };
    expect(body.result.tools.map((t) => t.name).sort()).toEqual([
      'health_experiment',
      'health_log_day',
      'health_log_flare',
      'health_report',
    ]);
  });

  it('refuses a bad token', async () => {
    const { rpc } = await fresh();
    expect((await rpc('tools/list', {}, 'nope')).status).toBe(401);
  });
});

describe('mcp: flares', () => {
  let env: Env;
  beforeAll(async () => {
    env = await fresh();
  });

  it('defaults to today and count 1, and returns the 1-3 day lookback', async () => {
    await env.ok('health_log_day', {
      date: '2026-11-06',
      preparedFood: true,
      meals: { lunch: 'Just Salad' },
    });
    await env.ok('health_log_day', { date: '2026-11-04', alcohol: true });
    const r = await env.ok('health_log_flare', {
      id: ID(1),
      issue: 'canker_sore',
      location: 'lower lip',
      severity: 4,
    });
    expect(r.flare).toMatchObject({
      _id: ID(1),
      date: '2026-11-07',
      issue: 'canker_sore',
      count: 1,
      location: 'lower lip',
      severity: 4,
    });
    expect(
      r.lookback.map(
        (l: { date: string; daysBefore: number; day: unknown }) => [
          l.date,
          l.daysBefore,
          l.day === null ? null : 'logged',
        ]
      )
    ).toEqual([
      ['2026-11-06', 1, 'logged'],
      ['2026-11-05', 2, null],
      ['2026-11-04', 3, 'logged'],
    ]);
    expect(r.lookback[0].day.meals).toEqual({ lunch: 'Just Salad' });
    expect(r.experiment).toBeNull();
  });

  it('resending the id replaces the flare', async () => {
    const first = await env.store.flares.findOne({ _id: ID(1) });
    env.clock.set('2026-11-07T19:00:00Z');
    const r = await env.ok('health_log_flare', {
      id: ID(1),
      issue: 'canker_sore',
      count: 2,
    });
    expect(r.flare.count).toBe(2);
    expect(r.flare.location).toBeUndefined();
    expect(await env.store.flares.countDocuments()).toBe(1);
    const saved = await env.store.flares.findOne({ _id: ID(1) });
    expect(saved!.createdAt).toEqual(first!.createdAt);
    expect(saved!.updatedAt > first!.updatedAt).toBe(true);
  });

  it('without an id, each call is a new flare', async () => {
    await env.ok('health_log_flare', {
      issue: 'canker_sore',
      date: '2026-11-01',
    });
    expect(await env.store.flares.countDocuments()).toBe(2);
  });

  it('refuses bad input', async () => {
    const r = await env.call('health_log_flare', {
      issue: 'Canker Sore',
      severity: 11,
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/issue/);
  });
});

describe('mcp: day logs', () => {
  let env: Env;
  beforeAll(async () => {
    env = await fresh();
  });

  it('keeps one row per date; resending merges the fields given', async () => {
    await env.ok('health_log_day', {
      sleepHours: 6.5,
      meals: { breakfast: 'oatmeal' },
    });
    const d = await env.ok('health_log_day', {
      alcohol: false,
      meals: { lunch: 'Just Salad' },
      preparedFood: true,
    });
    expect(d).toMatchObject({
      _id: '2026-11-07',
      date: '2026-11-07',
      sleepHours: 6.5,
      alcohol: false,
      preparedFood: true,
      meals: { breakfast: 'oatmeal', lunch: 'Just Salad' },
    });
    expect(await env.store.days.countDocuments()).toBe(1);
  });

  it('a list of meals replaces them; null clears a field', async () => {
    const d = await env.ok('health_log_day', {
      meals: ['oatmeal', 'Just Salad', 'pizza'],
      sleepHours: null,
    });
    expect(d.meals).toEqual(['oatmeal', 'Just Salad', 'pizza']);
    expect(d.sleepHours).toBeUndefined();
    expect(d.alcohol).toBe(false);
  });
});

describe('mcp: experiments', () => {
  let env: Env;
  beforeAll(async () => {
    env = await fresh();
  });

  it('creates one with an id from the name and start today', async () => {
    const e = await env.ok('health_experiment', {
      name: 'No Just Salad',
      issue: 'canker_sore',
      rule: 'no Just Salad',
    });
    expect(e).toMatchObject({
      _id: 'no-just-salad',
      start: '2026-11-07',
      rule: 'no Just Salad',
    });
    expect(e.end).toBeUndefined();
  });

  it('a new one needs name, issue and rule', async () => {
    const r = await env.call('health_experiment', { name: 'Less coffee' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/name, issue and rule/);
  });

  it('refuses a second active experiment', async () => {
    const r = await env.call('health_experiment', {
      name: 'SLS-free toothpaste',
      issue: 'canker_sore',
      rule: 'SLS-free toothpaste only',
      start: '2026-11-08',
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/one experiment at a time/);
  });

  it('updates by exact name (only the fields given) and ends it', async () => {
    const e = await env.ok('health_experiment', {
      name: 'no just salad',
      start: '2026-10-25',
      end: '2026-11-07',
    });
    expect(e).toMatchObject({
      _id: 'no-just-salad',
      name: 'No Just Salad',
      issue: 'canker_sore',
      start: '2026-10-25',
      end: '2026-11-07',
    });
    const next = await env.ok('health_experiment', {
      name: 'SLS-free toothpaste',
      issue: 'canker_sore',
      rule: 'SLS-free toothpaste only',
      start: '2026-11-08',
    });
    expect(next._id).toBe('sls-free-toothpaste');
  });

  it('refuses an end before the start and an unknown id', async () => {
    const r = await env.call('health_experiment', {
      id: 'sls-free-toothpaste',
      end: '2026-11-01',
    });
    expect(r.text).toMatch(/before start/);
    const u = await env.call('health_experiment', { id: 'nope', end: null });
    expect(u.text).toMatch(/No experiment nope/);
  });
});

describe('mcp: report', () => {
  let env: Env;
  beforeAll(async () => {
    env = await fresh();
    let n = 0;
    const flare = (date: string, count = 1, issue = 'canker_sore') =>
      env.ok('health_log_flare', { id: ID(++n), date, count, issue });
    // Baseline before the experiment (10-11..10-24): 3 flares, 4 sores.
    await flare('2026-10-12', 2);
    await flare('2026-10-18');
    await flare('2026-10-22');
    // Outside both windows; and another issue.
    await flare('2026-10-05');
    await flare('2026-10-30', 1, 'migraine');
    await env.ok('health_experiment', {
      name: 'No Just Salad',
      issue: 'canker_sore',
      rule: 'no Just Salad',
      start: '2026-10-25',
    });
    // During (10-25..today 11-07, 14 days): 1 flare.
    await flare('2026-11-03');
    await env.ok('health_log_day', {
      date: '2026-11-02',
      preparedFood: true,
      meals: ['Chipotle bowl'],
    });
    await env.ok('health_log_day', { date: '2026-10-31', alcohol: true });
  });

  it('compares the flare rate during an experiment with the period before', async () => {
    const r = await env.ok('health_report', { issue: 'canker_sore' });
    expect([r.from, r.to]).toEqual(['2026-09-13', '2026-11-07']);
    // 5 flares, 6 sores over 56 days (8 weeks).
    expect(r.summary).toMatchObject({
      days: 56,
      flares: 5,
      count: 6,
      flaresPerWeek: 0.63,
      countPerWeek: 0.75,
    });
    expect(r.experiments).toHaveLength(1);
    expect(r.experiments[0]).toMatchObject({
      name: 'No Just Salad',
      ongoing: true,
      during: {
        from: '2026-10-25',
        to: '2026-11-07',
        days: 14,
        flares: 1,
        count: 1,
        flaresPerWeek: 0.5,
        countPerWeek: 0.5,
      },
      before: {
        from: '2026-10-11',
        to: '2026-10-24',
        days: 14,
        flares: 3,
        count: 4,
        flaresPerWeek: 1.5,
        countPerWeek: 2,
      },
      beforeOverlaps: [],
    });
  });

  it('lists each flare with its lookback days and the experiment that day', async () => {
    const r = await env.ok('health_report', {
      issue: 'canker_sore',
      from: '2026-10-20',
    });
    expect(r.flares.map((f: { date: string }) => f.date)).toEqual([
      '2026-10-22',
      '2026-11-03',
    ]);
    const last = r.flares[1];
    expect(last.experiment).toBe('No Just Salad');
    expect(r.flares[0].experiment).toBeNull();
    expect(
      last.lookback.map(
        (l: { date: string; day: { preparedFood?: boolean } | null }) => [
          l.date,
          l.day && (l.day.preparedFood ? 'prepared' : 'logged'),
        ]
      )
    ).toEqual([
      ['2026-11-02', 'prepared'],
      ['2026-11-01', null],
      ['2026-10-31', 'logged'],
    ]);
    // The before window reaches past `from`; the comparison is unchanged.
    expect(r.experiments[0].before.flares).toBe(3);
  });

  it('takes a custom lookback window', async () => {
    const r = await env.ok('health_report', {
      issue: 'canker_sore',
      from: '2026-11-01',
      lookbackFrom: 2,
      lookbackTo: 2,
    });
    expect(r.flares[0].lookback).toEqual([
      { date: '2026-11-01', daysBefore: 2, day: null },
    ]);
  });

  it('refuses a reversed or too long range', async () => {
    expect(
      (
        await env.call('health_report', {
          issue: 'canker_sore',
          from: '2026-12-01',
        })
      ).text
    ).toMatch(/after/);
    expect(
      (
        await env.call('health_report', {
          issue: 'canker_sore',
          from: '2024-01-01',
        })
      ).text
    ).toMatch(/At most 366 days/);
  });
});
