import type { Db } from 'mongodb';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PASSWORD, setup } from './helpers/app.js';
import { testDb } from './helpers/mongo.js';

let db: Db;
let app: Awaited<ReturnType<typeof setup>>['app'];
let store: Awaited<ReturnType<typeof setup>>['store'];
let cookie = '';

beforeAll(async () => {
  db = await testDb();
});
beforeEach(async () => {
  await db.dropDatabase();
  ({ app, store } = await setup(db));
  const res = await app.request('/login', form({ password: PASSWORD }));
  expect(res.status).toBe(302);
  cookie = res.headers.get('set-cookie')!.split(';')[0]!;
});

function form(
  data: Record<string, string | string[]>,
  headers: Record<string, string> = {}
) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(data))
    for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: body.toString(),
  };
}
const get = (path: string) => app.request(path, { headers: { cookie } });
const post = (
  path: string,
  data: Record<string, string | string[]>,
  headers: Record<string, string> = {}
) => app.request(path, form(data, { cookie, ...headers }));

describe('auth', () => {
  it('pages need the password', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
    expect(
      (await app.request('/login', form({ password: 'nope' }))).status
    ).toBe(401);
    expect((await app.request('/healthz')).status).toBe(200);
    expect((await app.request('/static/styles.css')).status).toBe(200);
  });
});

describe('pages', () => {
  it('empty list points at adding', async () => {
    const html = await (await get('/')).text();
    expect(html).toContain('No recipes yet');
  });

  it('import prefill, save, view', async () => {
    const pre = await get(
      `/new?url=${encodeURIComponent('https://www.bbcgoodfood.com/recipes/easy-chicken-curry')}`
    );
    const html = await pre.text();
    expect(html).toContain('value="Easy chicken curry"');
    expect(html).toContain('Filled in from the page');
    expect(html).toContain('2 tbsp sunflower oil');

    const saved = await post('/new', {
      title: 'Easy chicken curry',
      ingredients: '2 tbsp sunflower oil\n\n1 onion',
      steps: 'Fry.\nSimmer.',
      tags: 'chicken, Curry',
      prepMinutes: '5',
      cookMinutes: '',
      sourceUrl: 'https://www.bbcgoodfood.com/recipes/easy-chicken-curry',
    });
    expect(saved.status).toBe(302);
    expect(saved.headers.get('location')).toBe('/r/easy-chicken-curry');
    const r = await store.getRecipe('easy-chicken-curry');
    expect(r).toMatchObject({
      ingredients: ['2 tbsp sunflower oil', '1 onion'],
      tags: ['chicken', 'curry'],
      prepMinutes: 5,
      createdVia: 'web',
    });
    expect(r && 'cookMinutes' in r).toBe(false);

    const page = await (await get('/r/easy-chicken-curry')).text();
    expect(page).toContain('Easy chicken curry');
    expect(page).toContain('Prep 5 min');

    // Importing it again shows the duplicate.
    const again = await (
      await get(
        `/new?url=${encodeURIComponent('https://www.bbcgoodfood.com/recipes/easy-chicken-curry')}`
      )
    ).text();
    expect(again).toContain('Already saved (same source page)');
  });

  it('import errors stay on the form', async () => {
    const res = await get(
      `/new?url=${encodeURIComponent('https://example.com/no-recipe')}`
    );
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('No schema.org Recipe data');
    const priv = await get(
      `/new?url=${encodeURIComponent('http://192.168.1.1/')}`
    );
    expect(await priv.text()).toContain('inside the home network');
  });

  it('star taps rate via HTMX (tap again clears), made-it logs a cook', async () => {
    await store.addMember('Dan');
    await store.addMember('Kim');
    await store.addRecipe({ title: 'Tacos' }, 'web');
    const hx = { 'hx-request': 'true' };
    const frag = await (
      await post('/r/tacos/rate', { member: 'dan', stars: '4' }, hx)
    ).text();
    expect(frag).toContain('id="ratings"');
    expect(frag).not.toContain('<html');
    expect((await store.ratings.findOne({ _id: 'tacos:dan' }))!.stars).toBe(4);
    await post('/r/tacos/rate', { member: 'dan', stars: '4' }, hx);
    expect(await store.ratings.countDocuments()).toBe(0);

    const made = await post('/r/tacos/cooked', {
      date: '2026-10-24',
      eaters: ['dan'],
    });
    expect(made.status).toBe(302);
    expect(await store.cooks.findOne()).toMatchObject({
      cookedOn: '2026-10-24',
      eaters: ['dan'],
    });
    expect(await (await get('/r/tacos')).text()).toContain('made 2 days ago');
  });

  it('search, edit, delete', async () => {
    await store.addRecipe({ title: 'Beef Chili', tags: ['beef'] }, 'web');
    await store.addRecipe({ title: 'Salad' }, 'web');
    const list = await (await get('/?q=chili')).text();
    expect(list).toContain('Beef Chili');
    expect(list).not.toContain('>Salad<');

    const edit = await post('/r/beef-chili/edit', {
      title: 'Texas Chili',
      tags: '',
      ingredients: '',
      steps: '',
    });
    expect(edit.status).toBe(302);
    expect(await store.getRecipe('beef-chili')).toMatchObject({
      title: 'Texas Chili',
      tags: [],
    });
    const blank = await post('/r/beef-chili/edit', {
      title: '',
      ingredients: '',
      steps: '',
      tags: '',
    });
    expect(blank.status).toBe(422);

    await post('/r/beef-chili/delete', {});
    expect(await store.getRecipe('beef-chili')).toBeNull();
  });

  it('what to cook and family pages', async () => {
    await post('/family', { name: 'Dan' });
    await post('/family', { name: 'Kim' });
    const dupe = await post('/family', { name: 'dan' });
    expect(await dupe.text()).toContain('already a member');
    await store.addRecipe({ title: 'Tacos', totalMinutes: 30 }, 'web');
    await store.addRecipe({ title: 'Roast', totalMinutes: 240 }, 'web');
    const page = await (await get('/cook?eaters=dan&maxMinutes=60')).text();
    expect(page).toContain('Tacos');
    expect(page).not.toContain('Roast');
    await post('/family/kim', { active: 'false' });
    expect((await store.resolveMember('kim')).active).toBe(false);
  });
});
