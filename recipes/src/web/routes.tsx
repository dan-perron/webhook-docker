import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { ZodError } from 'zod';
import type { FailureLimiter } from '../auth/rateLimit.js';
import { StoreError } from '../db/store.js';
import { recommend } from '../domain/recommend.js';
import { FetchRefused } from '../import/fetchPage.js';
import { NoRecipeFound } from '../import/schemaOrg.js';
import type { Services } from '../services.js';
import { basePath, home, url } from '../util/url.js';
import { LoginPage } from './layout.js';
import {
  CookPage,
  FamilyPage,
  ListPage,
  RatingsBlock,
  RecipeForm,
  RecipePage,
  type FormValues,
} from './pages.js';
import {
  hasSession,
  passwordMatches,
  startSession,
  type SessionConfig,
} from './session.js';

export interface WebConfig {
  session: SessionConfig;
  limiter: FailureLimiter;
}

/** Best-effort client address behind Apache. */
const clientKey = (c: Context) =>
  c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'direct';

const TEXT_FIELDS = [
  'title',
  'description',
  'sourceUrl',
  'imageUrl',
  'servings',
  'cuisine',
  'course',
  'notes',
] as const;
const NUMBER_FIELDS = ['prepMinutes', 'cookMinutes', 'totalMinutes'] as const;

/**
 * Form body -> recipe input. Blank optional fields are null (cleared on
 * edit, dropped on add); the store validates everything.
 */
function formToRecipe(form: Record<string, unknown>) {
  const s = (k: string) =>
    typeof form[k] === 'string' ? (form[k] as string) : '';
  const out: Record<string, unknown> = {};
  for (const k of TEXT_FIELDS) out[k] = s(k).trim() || null;
  for (const k of NUMBER_FIELDS) {
    const raw = s(k).trim();
    out[k] = raw === '' ? null : Number(raw);
  }
  const lines = (k: string) =>
    s(k)
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean);
  out.ingredients = lines('ingredients');
  out.steps = lines('steps');
  out.tags = s('tags')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  out.title = s('title').trim();
  return out;
}

const dropNulls = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null));

function errorText(e: unknown): string | undefined {
  if (
    e instanceof StoreError ||
    e instanceof FetchRefused ||
    e instanceof NoRecipeFound
  )
    return e.message;
  if (e instanceof ZodError)
    return `Please fix: ${e.issues.map((i) => `${i.path.join('.') || 'form'} — ${i.message}`).join('; ')}`;
  return undefined;
}

const asArray = (x: unknown): string[] =>
  Array.isArray(x)
    ? x.filter((v): v is string => typeof v === 'string')
    : typeof x === 'string'
      ? [x]
      : [];

export function webRoutes(s: Services, cfg: WebConfig): Hono {
  const r = new Hono();
  const { store } = s;

  // CSS/JS from ./public at <base>/static/*.
  r.use(
    '/static/*',
    serveStatic({
      root: './public',
      rewriteRequestPath: (p) =>
        p.replace(new RegExp(`^${basePath}/static`), ''),
    })
  );

  r.get('/login', (c) => c.html(<LoginPage />));
  r.post('/login', async (c) => {
    const key = clientKey(c);
    if (cfg.limiter.blocked(key))
      return c.html(
        <LoginPage error="Too many attempts. Try again later." />,
        429
      );
    const body = await c.req.parseBody();
    if (!passwordMatches(cfg.session, body.password)) {
      cfg.limiter.fail(key);
      return c.html(<LoginPage error="Wrong password." />, 401);
    }
    cfg.limiter.reset(key);
    await startSession(c, cfg.session);
    return c.redirect(home);
  });

  const requireSession: MiddlewareHandler = async (c, next) => {
    if (await hasSession(c, cfg.session)) return next();
    return c.redirect(url('/login'));
  };
  r.use('/', requireSession);
  for (const p of ['/r/*', '/new', '/cook', '/family', '/family/*'])
    r.use(p, requireSession);

  r.get('/', async (c) => {
    const q = c.req.query('q') ?? '';
    const tag = c.req.query('tag') ?? '';
    const [items, tags, total] = await Promise.all([
      store.search({ text: q, tag: tag || undefined, limit: 200 }),
      store.tagCounts(),
      store.recipes.countDocuments(),
    ]);
    return c.html(
      <ListPage
        items={items}
        total={total}
        q={q}
        tag={tag}
        tags={tags}
        today={s.today()}
      />
    );
  });

  // ---- add ----

  r.get('/new', async (c) => {
    const importUrl = c.req.query('url')?.trim();
    if (!importUrl)
      return c.html(<RecipeForm mode="new" values={{}} action={url('/new')} />);
    try {
      const draft = await s.importUrl(importUrl);
      const dup = await store.findDuplicate(draft);
      return c.html(
        <RecipeForm
          mode="new"
          values={{ ...draft, sourceUrl: draft.sourceUrl ?? importUrl }}
          action={url('/new')}
          importUrl={importUrl}
          notice={
            dup
              ? undefined
              : 'Filled in from the page. Check it over, then save.'
          }
          error={
            dup
              ? `Already saved (${dup.reason}): ${dup.recipe.title}.`
              : undefined
          }
          duplicateOf={dup?.recipe._id}
        />
      );
    } catch (e) {
      const msg = errorText(e);
      if (!msg) throw e;
      return c.html(
        <RecipeForm
          mode="new"
          values={{ sourceUrl: importUrl }}
          action={url('/new')}
          importUrl={importUrl}
          error={msg}
        />,
        422
      );
    }
  });

  r.post('/new', async (c) => {
    const form = await c.req.parseBody();
    const input = formToRecipe(form);
    try {
      const saved = await store.addRecipe(dropNulls(input), 'web', {
        allowDuplicateTitle: form.allowDuplicateTitle === '1',
      });
      return c.redirect(url(`/r/${encodeURIComponent(saved._id)}`));
    } catch (e) {
      const msg = errorText(e);
      if (!msg) throw e;
      const details =
        e instanceof StoreError
          ? (e.details as { duplicateOf?: string } | undefined)
          : undefined;
      return c.html(
        <RecipeForm
          mode="new"
          values={dropNulls(input) as FormValues}
          action={url('/new')}
          error={msg}
          duplicateOf={details?.duplicateOf}
        />,
        422
      );
    }
  });

  // ---- one recipe ----

  const loadRecipe = async (c: Context) => {
    const id = c.req.param('id')!;
    const recipe = await store.getRecipe(id);
    return recipe ?? null;
  };

  r.get('/r/:id', async (c) => {
    const recipe = await loadRecipe(c);
    if (!recipe) return c.notFound();
    const d = await store.recipeDetail(recipe._id);
    return c.html(
      <RecipePage
        recipe={d.recipe}
        members={d.members}
        ratings={d.ratings}
        cooks={d.cooks}
        today={s.today()}
      />
    );
  });

  r.post('/r/:id/rate', async (c) => {
    const recipe = await loadRecipe(c);
    if (!recipe) return c.notFound();
    const form = await c.req.parseBody();
    const member = String(form.member ?? '');
    const stars = Number(form.stars);
    const current = await store.ratings.findOne({
      _id: `${recipe._id}:${member}`,
    });
    try {
      // Tapping your current star again clears it.
      if (current?.stars === stars) await store.unrate(recipe._id, member);
      else await store.rate(recipe._id, member, stars);
    } catch (e) {
      const msg = errorText(e);
      if (!msg) throw e;
      return c.text(msg, 422);
    }
    const d = await store.recipeDetail(recipe._id);
    const block = (
      <RatingsBlock
        recipeId={recipe._id}
        members={d.members}
        ratings={d.ratings}
      />
    );
    // HTMX swaps the block in place; a plain form post goes back to the page.
    return c.req.header('hx-request')
      ? c.html(block)
      : c.redirect(url(`/r/${encodeURIComponent(recipe._id)}`));
  });

  r.post('/r/:id/cooked', async (c) => {
    const recipe = await loadRecipe(c);
    if (!recipe) return c.notFound();
    const form = await c.req.parseBody({ all: true });
    try {
      await store.logCook(recipe._id, {
        cookedOn: String(form.date ?? s.today()),
        eaters: asArray(form.eaters),
      });
    } catch (e) {
      const msg = errorText(e);
      if (!msg) throw e;
      return c.text(msg, 422);
    }
    return c.redirect(url(`/r/${encodeURIComponent(recipe._id)}`));
  });

  r.post('/r/:id/cooked/:cookId/delete', async (c) => {
    const recipe = await loadRecipe(c);
    if (!recipe) return c.notFound();
    await store.removeCook(c.req.param('cookId'));
    return c.redirect(url(`/r/${encodeURIComponent(recipe._id)}`));
  });

  r.get('/r/:id/edit', async (c) => {
    const recipe = await loadRecipe(c);
    if (!recipe) return c.notFound();
    return c.html(
      <RecipeForm
        mode="edit"
        values={recipe}
        action={url(`/r/${encodeURIComponent(recipe._id)}/edit`)}
      />
    );
  });

  r.post('/r/:id/edit', async (c) => {
    const recipe = await loadRecipe(c);
    if (!recipe) return c.notFound();
    const input = formToRecipe(await c.req.parseBody());
    try {
      await store.updateRecipe(recipe._id, input);
      return c.redirect(url(`/r/${encodeURIComponent(recipe._id)}`));
    } catch (e) {
      const msg = errorText(e);
      if (!msg) throw e;
      return c.html(
        <RecipeForm
          mode="edit"
          values={dropNulls(input) as FormValues}
          action={url(`/r/${encodeURIComponent(recipe._id)}/edit`)}
          error={msg}
        />,
        422
      );
    }
  });

  r.post('/r/:id/delete', async (c) => {
    const recipe = await loadRecipe(c);
    if (!recipe) return c.notFound();
    await store.removeRecipe(recipe._id);
    return c.redirect(home);
  });

  // ---- what to cook ----

  r.get('/cook', async (c) => {
    const data = await store.recommendData();
    const tags = await store.tagCounts();
    const active = data.members.filter((m) => m.active);
    const asked = c.req.queries('eaters') ?? [];
    const eaters = (asked.length ? asked : active.map((m) => m._id)).filter(
      (id) => data.members.some((m) => m._id === id)
    );
    const maxRaw = Number(c.req.query('maxMinutes'));
    const maxMinutes =
      Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : undefined;
    const tag = c.req.query('tag') ?? '';
    const results = eaters.length
      ? recommend(
          data,
          {
            eaters,
            maxMinutes,
            tags: tag ? [tag] : [],
            limit: 10,
            today: s.today(),
          },
          s.recommend
        )
      : [];
    return c.html(
      <CookPage
        members={data.members}
        eaters={eaters}
        maxMinutes={maxMinutes}
        tag={tag}
        tags={tags}
        results={results}
      />
    );
  });

  // ---- family ----

  const familyPage = async (c: Context, error?: string) => {
    const [members, ratings] = await Promise.all([
      store.listMembers(),
      store.ratings.find().toArray(),
    ]);
    const rated = new Map<string, number>();
    for (const x of ratings)
      rated.set(x.memberId, (rated.get(x.memberId) ?? 0) + 1);
    return c.html(
      <FamilyPage members={members} rated={rated} error={error} />,
      error ? 422 : 200
    );
  };

  r.get('/family', (c) => familyPage(c));

  r.post('/family', async (c) => {
    const form = await c.req.parseBody();
    try {
      await store.addMember(String(form.name ?? ''));
    } catch (e) {
      const msg = errorText(e);
      if (!msg) throw e;
      return familyPage(c, msg);
    }
    return c.redirect(url('/family'));
  });

  r.post('/family/:id', async (c) => {
    const form = await c.req.parseBody();
    try {
      await store.updateMember(c.req.param('id'), {
        name: typeof form.name === 'string' ? form.name : undefined,
        active:
          form.active === 'true'
            ? true
            : form.active === 'false'
              ? false
              : undefined,
      });
    } catch (e) {
      const msg = errorText(e);
      if (!msg) throw e;
      return familyPage(c, msg);
    }
    return c.redirect(url('/family'));
  });

  return r;
}
