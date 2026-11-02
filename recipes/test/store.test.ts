import type { Db } from 'mongodb';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RecipeStore, StoreError } from '../src/db/store.js';
import { slugify, sourceKeyOf } from '../src/domain/slug.js';
import { testDb } from './helpers/mongo.js';

let db: Db;
let store: RecipeStore;
beforeAll(async () => {
  db = await testDb();
});
beforeEach(async () => {
  await db.dropDatabase();
  store = new RecipeStore(db, () => new Date('2026-10-26T12:00:00Z'));
  await store.ensureIndexes();
});

describe('slugs and source keys', () => {
  it('slugify', () => {
    expect(slugify('Crème Brûlée!')).toBe('creme-brulee');
    expect(slugify('Mac & Cheese')).toBe('mac-and-cheese');
    expect(slugify('!!!')).toBe('recipe');
  });
  it('sourceKeyOf ignores scheme, www, tracking, fragment, trailing slash', () => {
    expect(
      sourceKeyOf('https://www.Example.com/r/chili/?utm_source=x&b=2&a=1#top')
    ).toBe('example.com/r/chili?a=1&b=2');
    expect(sourceKeyOf('http://example.com/r/chili')).toBe(
      'example.com/r/chili'
    );
    expect(sourceKeyOf('ftp://example.com/x')).toBeUndefined();
  });
});

describe('recipes', () => {
  it('adds with a slug id, normalized tags, and no blank fields', async () => {
    const r = await store.addRecipe(
      {
        title: '  Chili  ',
        description: '   ',
        tags: ['Beef', 'beef', ' Weeknight '],
        ingredients: ['1 lb beef', ''],
        prepMinutes: 10,
      },
      'mcp'
    );
    expect(r).toMatchObject({
      _id: 'chili',
      title: 'Chili',
      tags: ['beef', 'weeknight'],
      ingredients: ['1 lb beef'],
      steps: [],
      createdVia: 'mcp',
    });
    expect('description' in r).toBe(false);
    const stored = await store.getRecipe('chili');
    expect(stored && 'description' in stored).toBe(false);
  });

  it('refuses the same source page (any URL form) and the same title', async () => {
    await store.addRecipe(
      { title: 'Chili', sourceUrl: 'https://www.example.com/chili/' },
      'web'
    );
    await expect(
      store.addRecipe(
        { title: 'Other', sourceUrl: 'http://example.com/chili?utm_medium=x' },
        'web'
      )
    ).rejects.toThrow('Already saved (same source page): Chili (id chili)');
    await expect(store.addRecipe({ title: 'CHILI' }, 'web')).rejects.toThrow(
      'same title'
    );
    // A different dish with the same name, on purpose:
    const again = await store.addRecipe({ title: 'Chili' }, 'web', {
      allowDuplicateTitle: true,
    });
    expect(again._id).toBe('chili-2');
  });

  it('resolves by id or title and suggests close matches', async () => {
    await store.addRecipe({ title: 'Chicken Tikka' }, 'web');
    await store.addRecipe({ title: 'Chicken Soup' }, 'web');
    expect((await store.resolveRecipe('chicken-soup')).title).toBe(
      'Chicken Soup'
    );
    expect((await store.resolveRecipe('chicken tikka')).title).toBe(
      'Chicken Tikka'
    );
    await expect(store.resolveRecipe('chicken')).rejects.toThrow(
      /Did you mean: Chicken Soup \(id chicken-soup\); Chicken Tikka/
    );
  });

  it('updates fields, clears with null, keeps the id', async () => {
    await store.addRecipe(
      { title: 'Chili', notes: 'Spicy', totalMinutes: 60 },
      'web'
    );
    const r = await store.updateRecipe('chili', {
      title: 'Texas Chili',
      notes: null,
      tags: ['beef'],
    });
    expect(r).toMatchObject({
      _id: 'chili',
      title: 'Texas Chili',
      tags: ['beef'],
      totalMinutes: 60,
    });
    expect('notes' in r).toBe(false);
    await expect(store.updateRecipe('chili', { title: '' })).rejects.toThrow();
  });

  it('removing a recipe removes its ratings and cooks', async () => {
    await store.addMember('Dan');
    await store.addRecipe({ title: 'Chili' }, 'web');
    await store.rate('chili', 'dan', 5);
    await store.logCook('chili', { cookedOn: '2026-10-20', eaters: [] });
    await store.removeRecipe('chili');
    expect(await store.ratings.countDocuments()).toBe(0);
    expect(await store.cooks.countDocuments()).toBe(0);
  });

  it('search: all words, title matches first, tag/ingredient/time filters', async () => {
    await store.addRecipe(
      {
        title: 'Beef Chili',
        tags: ['beef'],
        ingredients: ['1 lb beef', '1 onion'],
        totalMinutes: 60,
      },
      'web'
    );
    await store.addRecipe(
      {
        title: 'Tacos',
        description: 'Beef tacos',
        tags: ['beef', 'mexican'],
        ingredients: ['1 lb beef'],
        totalMinutes: 25,
      },
      'web'
    );
    await store.addRecipe({ title: 'Salad', ingredients: ['lettuce'] }, 'web');
    expect((await store.search({ text: 'beef' })).map((r) => r.id)).toEqual([
      'beef-chili',
      'tacos',
    ]);
    expect(
      (await store.search({ text: 'beef tacos' })).map((r) => r.id)
    ).toEqual(['tacos']);
    expect((await store.search({ tag: 'Mexican' })).map((r) => r.id)).toEqual([
      'tacos',
    ]);
    expect(
      (await store.search({ ingredient: 'onion' })).map((r) => r.id)
    ).toEqual(['beef-chili']);
    expect((await store.search({ maxMinutes: 30 })).map((r) => r.id)).toEqual([
      'tacos',
    ]);
    expect(await store.tagCounts()).toEqual([
      { tag: 'beef', count: 2 },
      { tag: 'mexican', count: 1 },
    ]);
  });
});

describe('members, ratings, cooks', () => {
  it('members resolve by name, case- and accent-insensitively', async () => {
    await store.addMember('Zoë');
    expect((await store.resolveMember('zoe')).name).toBe('Zoë');
    await expect(store.addMember('ZOE')).rejects.toThrow('already a member');
    await expect(store.resolveMember('Sam')).rejects.toThrow(
      'No family member named "Sam". Members: Zoë.'
    );
  });

  it('rename keeps the id (and ratings); inactive members are not default eaters', async () => {
    await store.addMember('Dan');
    await store.addMember('Kim');
    await store.addRecipe({ title: 'Chili' }, 'web');
    await store.rate('chili', 'Dan', 4);
    await store.updateMember('dan', { name: 'Daniel' });
    await store.updateMember('kim', { active: false });
    expect((await store.ratings.findOne())!.memberId).toBe('dan');
    const cook = await store.logCook('chili', {
      cookedOn: '2026-10-25',
      eaters: [],
    });
    expect(cook.eaters).toEqual(['dan']);
  });

  it('rating again replaces; stars must be 1-5', async () => {
    await store.addMember('Dan');
    await store.addRecipe({ title: 'Chili' }, 'web');
    await store.rate('chili', 'dan', 3, 'ok');
    await store.rate('chili', 'dan', 5);
    const all = await store.ratings.find().toArray();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ stars: 5 });
    expect(all[0]!.comment).toBeUndefined();
    await expect(store.rate('chili', 'dan', 6)).rejects.toThrow(StoreError);
  });

  it('summaries: average, count, last made', async () => {
    await store.addMember('Dan');
    await store.addMember('Kim');
    await store.addRecipe(
      { title: 'Chili', prepMinutes: 10, cookMinutes: 50 },
      'web'
    );
    await store.rate('chili', 'dan', 5);
    await store.rate('chili', 'kim', 4);
    await store.logCook('chili', { cookedOn: '2026-09-01', eaters: [] });
    await store.logCook('chili', { cookedOn: '2026-10-10', eaters: ['Kim'] });
    await expect(
      store.logCook('chili', { cookedOn: '10/10/2026', eaters: [] })
    ).rejects.toThrow('YYYY-MM-DD');
    expect(await store.summaries()).toEqual([
      {
        id: 'chili',
        title: 'Chili',
        tags: [],
        totalMinutes: 60,
        avgStars: 4.5,
        ratings: 2,
        lastCooked: '2026-10-10',
        timesCooked: 2,
      },
    ]);
  });
});
