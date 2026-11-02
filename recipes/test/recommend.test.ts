import { describe, expect, it } from 'vitest';
import {
  memberPrior,
  recommend,
  type RecommendParams,
} from '../src/domain/recommend.js';
import type { Cook, Member, Rating, Recipe } from '../src/domain/types.js';

// Every expected number is derived by hand in the comments.
const P: RecommendParams = {
  neutral: 3.5,
  priorWeight: 3,
  vetoAt: 2,
  spreadPenalty: 0.25,
  recencyPenalty: 2,
  recencyDays: 21,
  newBonus: 0.3,
};
const TODAY = '2026-10-26';
const at = new Date('2026-01-01T00:00:00Z');

const member = (id: string, active = true): Member => ({
  _id: id,
  name: id.toUpperCase(),
  active,
  createdAt: at,
});
const recipe = (id: string, extra: Partial<Recipe> = {}): Recipe => ({
  _id: id,
  title: id,
  ingredients: [],
  steps: [],
  tags: [],
  createdVia: 'web',
  createdAt: at,
  updatedAt: at,
  ...extra,
});
const rating = (recipeId: string, memberId: string, stars: number): Rating => ({
  _id: `${recipeId}:${memberId}`,
  recipeId,
  memberId,
  stars,
  ratedAt: at,
});
const cook = (recipeId: string, cookedOn: string): Cook => ({
  _id: `${recipeId}-${cookedOn}`,
  recipeId,
  cookedOn,
  eaters: [],
  createdAt: at,
});

const members = [member('a'), member('b')];
const recipes = [
  recipe('tacos', { tags: ['mexican', 'beef'], totalMinutes: 30 }),
  recipe('soup', { tags: ['vegetarian'], prepMinutes: 15, cookMinutes: 30 }),
  recipe('liver', { tags: ['beef'] }),
  recipe('new-dish'),
  recipe('pasta', { tags: ['vegetarian'], totalMinutes: 20 }),
];
const ratings = [
  rating('tacos', 'a', 5),
  rating('tacos', 'b', 4),
  rating('soup', 'a', 4),
  rating('soup', 'b', 4),
  rating('liver', 'a', 4),
  rating('liver', 'b', 2),
  rating('pasta', 'a', 5),
];
const cooks = [
  cook('tacos', '2026-10-01'),
  cook('tacos', '2026-10-19'), // latest: 7 days ago
  cook('soup', '2026-09-26'), // 30 days ago
];
const data = { recipes, ratings, cooks, members };
const run = (q: Partial<Parameters<typeof recommend>[1]> = {}) =>
  recommend(data, { eaters: ['a', 'b'], limit: 10, today: TODAY, ...q }, P);

describe('memberPrior', () => {
  it('shrinks the mean toward neutral by priorWeight ratings', () => {
    // a: [5,4,4,5] -> (18 + 3*3.5) / (4 + 3) = 28.5 / 7 = 4.0714
    expect(memberPrior([5, 4, 4, 5], P)).toBeCloseTo(4.0714, 4);
    // b: [4,4,2] -> (10 + 10.5) / 6 = 3.4167
    expect(memberPrior([4, 4, 2], P)).toBeCloseTo(3.4167, 4);
    // nobody rated anything -> neutral
    expect(memberPrior([], P)).toBe(3.5);
  });
});

describe('recommend', () => {
  it('ranks by family score, recency and novelty', () => {
    const recs = run();
    // new-dish: nobody rated; used = priors 4.0714, 3.4167; mean 3.7440,
    //   spread 0.6548 -> -0.1637 => family 3.5804; never made; +0.3 => 3.88
    // pasta: a 5, b unrated 3.4167; mean 4.2083, spread 1.5833 -> -0.3958
    //   => 3.8125 => 3.81
    // soup: 4, 4 => 4; made 30 days ago: -2 e^(-30/21) = -0.4793 => 3.52
    // tacos: 5, 4 => 4.5 - 0.25 = 4.25; 7 days: -2 e^(-1/3) = -1.4331
    //   => 2.82
    // liver: b rated 2 => vetoed, dropped.
    expect(recs.map((r) => [r.recipeId, r.score])).toEqual([
      ['new-dish', 3.88],
      ['pasta', 3.81],
      ['soup', 3.52],
      ['tacos', 2.82],
    ]);
    expect(recs[0]!.family).toBe(3.58);
    expect(recs[1]!.eaters).toEqual([
      { memberId: 'a', name: 'A', stars: 5, used: 5 },
      { memberId: 'b', name: 'B', stars: null, used: 3.42 },
    ]);
    expect(recs[3]).toMatchObject({ lastCooked: '2026-10-19', daysSince: 7 });
  });

  it('explains each pick', () => {
    const recs = Object.fromEntries(run().map((r) => [r.recipeId, r.reasons]));
    expect(recs['new-dish']).toEqual([
      'nobody eating has rated it yet',
      'never made',
    ]);
    expect(recs['pasta']).toEqual([
      'A 5★, B unrated (~3.4)',
      'never made',
      '20 min',
    ]);
    expect(recs['soup']).toEqual([
      'all 2 rated it ≥4★',
      'last made 30 days ago',
      '45 min',
    ]);
  });

  it('keeps a vetoed recipe only when asked, flagged', () => {
    const liver = run({ includeVetoed: true }).find(
      (r) => r.recipeId === 'liver'
    )!;
    // 4, 2: mean 3, spread 2 -> -0.5 => 2.5; never made
    expect(liver).toMatchObject({ vetoed: true, score: 2.5 });
    expect(liver.reasons[0]).toBe('vetoed: B 2★');
  });

  it("only the eaters' ratings count", () => {
    const recs = run({ eaters: ['a'] });
    // a alone: liver 4 is no longer vetoed; tacos 5 - 1.4331 = 3.57
    expect(recs.find((r) => r.recipeId === 'liver')!.vetoed).toBe(false);
    expect(recs.find((r) => r.recipeId === 'tacos')!.score).toBe(3.57);
    expect(recs.find((r) => r.recipeId === 'pasta')!.reasons[0]).toBe(
      'A rated it 5★'
    );
  });

  it('filters by time (unknown time excluded), tags and excluded tags', () => {
    // soup is 15 + 30 = 45 min; liver/new-dish have no time.
    expect(run({ maxMinutes: 30 }).map((r) => r.recipeId)).toEqual([
      'pasta',
      'tacos',
    ]);
    expect(run({ tags: ['vegetarian'] }).map((r) => r.recipeId)).toEqual([
      'pasta',
      'soup',
    ]);
    expect(
      run({ excludeTags: ['beef', 'vegetarian'] }).map((r) => r.recipeId)
    ).toEqual(['new-dish']);
  });

  it('made today costs the full recency penalty', () => {
    const recs = recommend(
      { ...data, cooks: [cook('soup', TODAY)] },
      { eaters: ['a', 'b'], limit: 10, today: TODAY },
      P
    );
    // 4 - 2 e^0 = 2
    const soup = recs.find((r) => r.recipeId === 'soup')!;
    expect(soup.score).toBe(2);
    expect(soup.reasons).toContain('made today');
  });

  it('respects the limit and rejects unknown eaters', () => {
    expect(run({ limit: 2 })).toHaveLength(2);
    expect(() => run({ eaters: ['zed'] })).toThrow('Unknown member id: zed');
    expect(run({ eaters: [] })).toEqual([]);
  });
});
