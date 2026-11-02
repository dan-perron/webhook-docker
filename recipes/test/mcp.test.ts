import type { Db } from 'mongodb';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mcpClient, setup } from './helpers/app.js';
import { testDb } from './helpers/mongo.js';

const BB = 'https://www.budgetbytes.com/one-pot-creamy-cajun-chicken-pasta/';

let db: Db;
let mcp: ReturnType<typeof mcpClient>;
beforeAll(async () => {
  db = await testDb();
});
beforeEach(async () => {
  await db.dropDatabase();
  const { app } = await setup(db);
  mcp = mcpClient(app);
});

describe('/mcp', () => {
  it('needs the bearer token', async () => {
    const res = await mcp.rpc('tools/list', {}, 'wrong');
    expect(res.status).toBe(401);
  });

  it('lists the tools with instructions', async () => {
    const init = await (
      await mcp.rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 't', version: '1' },
      })
    ).json();
    expect(init.result.instructions).toContain('Never make up ratings');
    const list = await (await mcp.rpc('tools/list', {})).json();
    expect(
      list.result.tools.map((t: { name: string }) => t.name).sort()
    ).toEqual([
      'add_member',
      'add_recipe',
      'get_recipe',
      'import_recipe_url',
      'list_members',
      'log_cooked',
      'rate_recipe',
      'remove_recipe',
      'search_recipes',
      'update_member',
      'update_recipe',
      'what_to_cook',
    ]);
  });
});

describe('recipe flow', () => {
  it('import by URL, refuse the duplicate, override fields', async () => {
    const preview = await mcp.call('import_recipe_url', { url: BB });
    expect(preview.data.draft.title).toBe('One Pot Creamy Cajun Chicken Pasta');
    expect(preview.data.alreadySaved).toBeNull();

    const added = await mcp.call('add_recipe', {
      url: BB,
      recipe: {
        tags: ['pasta', 'chicken', 'weeknight'],
        notes: 'Half the cajun for the kids',
      },
    });
    expect(added.isError).toBe(false);
    expect(added.data).toMatchObject({
      id: 'one-pot-creamy-cajun-chicken-pasta',
      link: 'https://djperron.com/recipes/r/one-pot-creamy-cajun-chicken-pasta',
      recipe: {
        sourceUrl: BB,
        totalMinutes: 30,
        tags: ['pasta', 'chicken', 'weeknight'],
        notes: 'Half the cajun for the kids',
        createdVia: 'mcp',
      },
    });
    expect(added.data.recipe.ingredients).toHaveLength(17);

    const dup = await mcp.call('add_recipe', { url: BB });
    expect(dup.isError).toBe(true);
    expect(dup.text).toContain('Already saved (same source page)');
    expect(
      (await mcp.call('import_recipe_url', { url: BB })).data.alreadySaved
    ).toMatchObject({
      id: 'one-pot-creamy-cajun-chicken-pasta',
    });
  });

  it('a page without recipe data is a clear tool error', async () => {
    const r = await mcp.call('add_recipe', {
      url: 'https://example.com/no-recipe',
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('No schema.org Recipe data');
  });

  it('manual add needs a title; bad fields are explained', async () => {
    expect((await mcp.call('add_recipe', {})).text).toContain('with a title');
    const ok = await mcp.call('add_recipe', {
      recipe: {
        title: 'Grandma Meatballs',
        ingredients: ['1 lb beef'],
        steps: ['Roll.', 'Bake.'],
        tags: ['Beef'],
      },
    });
    expect(ok.data.recipe.tags).toEqual(['beef']);
  });

  it('members, ratings, cooking and recommendations end to end', async () => {
    for (const name of ['Dan', 'Kim', 'Sam'])
      expect((await mcp.call('add_member', { name })).isError).toBe(false);
    await mcp.call('add_recipe', {
      recipe: { title: 'Tacos', tags: ['mexican'], totalMinutes: 30 },
    });
    await mcp.call('add_recipe', {
      recipe: { title: 'Liver', totalMinutes: 30 },
    });
    await mcp.call('add_recipe', {
      recipe: { title: 'Pancakes', tags: ['breakfast'], totalMinutes: 20 },
    });

    const bad = await mcp.call('rate_recipe', {
      recipe: 'Tacos',
      member: 'Zed',
      stars: 4,
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('Members: Dan, Kim, Sam');

    await mcp.call('rate_recipe', {
      recipe: 'liver',
      member: 'sam',
      stars: 1,
      comment: 'gross',
    });
    const logged = await mcp.call('log_cooked', {
      recipe: 'tacos',
      date: '2026-10-25',
      ratings: [
        { member: 'Dan', stars: 5 },
        { member: 'Kim', stars: 4 },
        { member: 'Sam', stars: 5 },
      ],
    });
    expect(logged.data.logged).toMatchObject({
      cookedOn: '2026-10-25',
      eaters: ['dan', 'kim', 'sam'],
    });

    const detail = await mcp.call('get_recipe', { recipe: 'tacos' });
    expect(detail.data.ratings).toHaveLength(3);
    expect(detail.data.cooks[0]).toMatchObject({
      cookedOn: '2026-10-25',
      eaters: ['Dan', 'Kim', 'Sam'],
    });

    const recs = await mcp.call('what_to_cook', {});
    expect(recs.data.eaters).toEqual(['Dan', 'Kim', 'Sam']);
    expect(recs.data.today).toBe('2026-10-26');
    const ids = recs.data.recommendations.map(
      (r: { recipeId: string }) => r.recipeId
    );
    // Liver is vetoed by Sam; tacos were made yesterday, so pancakes win.
    expect(ids).toEqual(['pancakes', 'tacos']);
    expect(recs.data.recommendations[1].reasons).toContain(
      'last made 1 day ago'
    );

    // Without Sam, liver is back.
    const noSam = await mcp.call('what_to_cook', { eaters: ['Dan', 'Kim'] });
    expect(
      noSam.data.recommendations.map((r: { recipeId: string }) => r.recipeId)
    ).toContain('liver');

    const breakfast = await mcp.call('what_to_cook', { tags: ['breakfast'] });
    expect(breakfast.data.recommendations).toHaveLength(1);
  });

  it('log_cooked with an unknown member writes nothing', async () => {
    await mcp.call('add_member', { name: 'Dan' });
    await mcp.call('add_recipe', { recipe: { title: 'Tacos' } });
    const r = await mcp.call('log_cooked', {
      recipe: 'tacos',
      ratings: [{ member: 'Nobody', stars: 5 }],
    });
    expect(r.isError).toBe(true);
    expect(
      (await mcp.call('get_recipe', { recipe: 'tacos' })).data.cooks
    ).toEqual([]);
  });

  it('update and remove (remove needs confirm)', async () => {
    await mcp.call('add_recipe', {
      recipe: { title: 'Tacos', notes: 'x', totalMinutes: 30 },
    });
    const up = await mcp.call('update_recipe', {
      recipe: 'tacos',
      fields: { title: 'Fish Tacos', tags: ['fish'] },
      clear: ['notes'],
    });
    expect(up.data.recipe).toMatchObject({
      title: 'Fish Tacos',
      tags: ['fish'],
      totalMinutes: 30,
    });
    expect(up.data.recipe.notes).toBeUndefined();

    const dry = await mcp.call('remove_recipe', { recipe: 'Fish Tacos' });
    expect(dry.data.wouldDelete).toEqual({ id: 'tacos', title: 'Fish Tacos' });
    expect((await mcp.call('search_recipes')).data.count).toBe(1);
    await mcp.call('remove_recipe', { recipe: 'tacos', confirm: true });
    expect((await mcp.call('search_recipes')).data.count).toBe(0);
  });
});
