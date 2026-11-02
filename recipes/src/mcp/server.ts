import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, ZodError } from 'zod';
import { StoreError } from '../db/store.js';
import { recipePatchSchema, recipeFieldShape } from '../domain/recipeInput.js';
import { recommend } from '../domain/recommend.js';
import { FetchRefused } from '../import/fetchPage.js';
import { NoRecipeFound } from '../import/schemaOrg.js';
import type { Services } from '../services.js';

const json = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});
const fail = (message: string) => ({
  content: [{ type: 'text' as const, text: message }],
  isError: true,
});

/** Known, user-facing errors become tool errors; anything else propagates. */
async function guard<T>(fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof StoreError)
      return e.details
        ? fail(`${e.message}\n${JSON.stringify(e.details)}`)
        : fail(e.message);
    if (e instanceof FetchRefused || e instanceof NoRecipeFound)
      return fail(e.message);
    if (e instanceof ZodError)
      return fail(
        `Invalid recipe: ${e.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`
      );
    throw e;
  }
}

const RECIPE_REF = z
  .string()
  .min(1)
  .describe('Recipe id (from search_recipes) or its exact title');
const MEMBER_REF = z.string().min(1).describe('Family member name');

export function createMcpServer(s: Services): McpServer {
  const { store } = s;
  const link = (id: string) => `${s.appUrl}/r/${encodeURIComponent(id)}`;

  const server = new McpServer(
    { name: 'recipes', version: '1.0.0' },
    {
      instructions: `The family recipe box: saved recipes, each family member's 1-5 star rating, and a log of when each recipe was made. Before adding a recipe, search_recipes for it (add_recipe also refuses exact duplicates by source page and title). To add from a link, pass url to add_recipe (it reads the page's schema.org data) or call import_recipe_url first to check the draft; when a page has no recipe data, read the page yourself and pass the fields. Write ingredients one line each as written and steps one per entry. Tags are lowercase and few (main protein, diet, method, occasion: e.g. "chicken", "vegetarian", "slow cooker", "weeknight"). Never make up ratings: only record stars a family member actually gave. For what_to_cook, ask who is eating when it isn't clear (the default is every active member). Dates are YYYY-MM-DD in America/Chicago; today is the default for log_cooked.`,
    }
  );

  server.registerTool(
    'add_recipe',
    {
      title: 'Add a recipe',
      description:
        'Save a recipe. Give url to import it from the page (schema.org Recipe data, which most recipe sites have), optionally with fields to override; or give the fields directly (title required). Refuses a recipe already saved from the same page or with the same title (returns the existing id) unless allowDuplicateTitle. Returns the saved recipe with its id and web link.',
      inputSchema: {
        url: z.url().optional().describe('Recipe page to import from'),
        recipe: recipePatchSchema
          .optional()
          .describe(
            'The recipe fields, or overrides applied on top of the import'
          ),
        allowDuplicateTitle: z
          .boolean()
          .optional()
          .describe('Save even if a different recipe has the same title'),
      },
    },
    async ({ url, recipe, allowDuplicateTitle }) =>
      guard(async () => {
        if (!url && !recipe?.title)
          return fail('Give url to import, or recipe fields with a title.');
        const imported = url ? await s.importUrl(url) : undefined;
        const fields = {
          ...imported,
          ...(url && !recipe?.sourceUrl
            ? { sourceUrl: imported?.sourceUrl ?? url }
            : {}),
          ...Object.fromEntries(
            Object.entries(recipe ?? {}).filter(([, v]) => v !== undefined)
          ),
        };
        const saved = await store.addRecipe(fields, 'mcp', {
          allowDuplicateTitle,
        });
        return json({ id: saved._id, link: link(saved._id), recipe: saved });
      })
  );

  server.registerTool(
    'import_recipe_url',
    {
      title: 'Preview a recipe import',
      description:
        "Read a recipe page's schema.org Recipe data and return the draft fields without saving. Also reports whether it's already saved.",
      inputSchema: { url: z.url() },
    },
    async ({ url }) =>
      guard(async () => {
        const draft = await s.importUrl(url);
        const dup = await store.findDuplicate(draft);
        return json({
          draft,
          alreadySaved: dup
            ? {
                id: dup.recipe._id,
                title: dup.recipe.title,
                reason: dup.reason,
              }
            : null,
        });
      })
  );

  server.registerTool(
    'update_recipe',
    {
      title: 'Update a recipe',
      description:
        'Change some fields of a saved recipe. Arrays (ingredients, steps, tags) replace the old list. Use clear to remove optional fields. The id never changes.',
      inputSchema: {
        recipe: RECIPE_REF,
        fields: recipePatchSchema.describe('Only the fields to change'),
        clear: z
          .array(
            z.enum(
              Object.keys(recipeFieldShape).filter((k) => k !== 'title') as [
                string,
                ...string[],
              ]
            )
          )
          .optional()
          .describe('Optional fields to remove'),
      },
    },
    async ({ recipe, fields, clear }) =>
      guard(async () => {
        const patch: Record<string, unknown> = Object.fromEntries(
          Object.entries(fields).filter(([, v]) => v !== undefined)
        );
        for (const k of clear ?? []) patch[k] = null;
        const saved = await store.updateRecipe(recipe, patch);
        return json({ id: saved._id, link: link(saved._id), recipe: saved });
      })
  );

  server.registerTool(
    'remove_recipe',
    {
      title: 'Remove a recipe',
      description:
        'Delete a recipe with its ratings and cook history. Needs confirm: true; call without it first to see what would be deleted.',
      inputSchema: { recipe: RECIPE_REF, confirm: z.boolean().optional() },
    },
    async ({ recipe, confirm }) =>
      guard(async () => {
        const d = await store.recipeDetail(recipe);
        if (!confirm)
          return json({
            wouldDelete: { id: d.recipe._id, title: d.recipe.title },
            ratings: d.ratings.length,
            cooks: d.cooks.length,
            note: 'Call again with confirm: true to delete.',
          });
        await store.removeRecipe(d.recipe._id);
        return json({ deleted: d.recipe._id, title: d.recipe.title });
      })
  );

  server.registerTool(
    'get_recipe',
    {
      title: 'Get a recipe',
      description:
        'The full recipe with every member’s rating and comment and the cook history (newest first).',
      inputSchema: { recipe: RECIPE_REF },
    },
    async ({ recipe }) =>
      guard(async () => {
        const d = await store.recipeDetail(recipe);
        return json({
          id: d.recipe._id,
          link: link(d.recipe._id),
          recipe: d.recipe,
          ratings: d.ratings.map((r) => ({
            member: r.member,
            stars: r.stars,
            comment: r.comment,
            ratedAt: r.ratedAt,
          })),
          unrated: d.members
            .filter(
              (m) => m.active && !d.ratings.some((r) => r.memberId === m._id)
            )
            .map((m) => m.name),
          cooks: d.cooks.map((c) => ({
            id: c._id,
            cookedOn: c.cookedOn,
            eaters: c.eaterNames,
            notes: c.notes,
          })),
        });
      })
  );

  server.registerTool(
    'search_recipes',
    {
      title: 'Search recipes',
      description:
        'Find saved recipes. query words must all appear in the title, tags, ingredients, cuisine, course or description; tag, ingredient and maxMinutes narrow further. No arguments lists everything. Returns summaries (average stars, times made, last made) and the tags in use.',
      inputSchema: {
        query: z.string().optional(),
        tag: z.string().optional(),
        ingredient: z
          .string()
          .optional()
          .describe('Substring of an ingredient line'),
        maxMinutes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Total time limit; recipes without a time are left out'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe('Default 50'),
      },
    },
    async ({ query, tag, ingredient, maxMinutes, limit }) =>
      guard(async () => {
        const results = await store.search({
          text: query,
          tag,
          ingredient,
          maxMinutes,
          limit,
        });
        return json({
          count: results.length,
          results,
          tagsInUse: (await store.tagCounts()).slice(0, 40),
        });
      })
  );

  server.registerTool(
    'list_members',
    {
      title: 'List family members',
      description:
        'The family members who eat and rate, with how many recipes each has rated.',
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const [members, ratings] = await Promise.all([
          store.listMembers(),
          store.ratings.find().toArray(),
        ]);
        return json(
          members.map((m) => ({
            name: m.name,
            id: m._id,
            active: m.active,
            rated: ratings.filter((r) => r.memberId === m._id).length,
          }))
        );
      })
  );

  server.registerTool(
    'add_member',
    {
      title: 'Add a family member',
      description: 'Add someone who eats and rates.',
      inputSchema: { name: z.string().min(1).max(40) },
    },
    async ({ name }) => guard(async () => json(await store.addMember(name)))
  );

  server.registerTool(
    'update_member',
    {
      title: 'Rename or (de)activate a member',
      description:
        'Rename a member, or set active: false for someone no longer eating with the family (keeps their ratings; they stop being a default eater).',
      inputSchema: {
        member: MEMBER_REF,
        name: z.string().min(1).max(40).optional(),
        active: z.boolean().optional(),
      },
    },
    async ({ member, name, active }) =>
      guard(async () =>
        json(await store.updateMember(member, { name, active }))
      )
  );

  server.registerTool(
    'rate_recipe',
    {
      title: 'Rate a recipe',
      description:
        "Record one family member's rating (1-5 stars, whole numbers), replacing their previous one. Only record ratings they actually gave.",
      inputSchema: {
        recipe: RECIPE_REF,
        member: MEMBER_REF,
        stars: z.number().int().min(1).max(5),
        comment: z.string().max(1000).optional(),
      },
    },
    async ({ recipe, member, stars, comment }) =>
      guard(async () => {
        const r = await store.rate(recipe, member, stars, comment);
        return json({
          recipe: r.recipeId,
          member,
          stars: r.stars,
          comment: r.comment,
        });
      })
  );

  server.registerTool(
    'log_cooked',
    {
      title: 'Log that a recipe was made',
      description:
        'Record that the family made a recipe (drives "last made" in what_to_cook), optionally with ratings from that meal in the same call.',
      inputSchema: {
        recipe: RECIPE_REF,
        date: z.string().optional().describe('YYYY-MM-DD; default today'),
        eaters: z
          .array(MEMBER_REF)
          .optional()
          .describe('Who ate; default every active member'),
        notes: z.string().max(1000).optional(),
        ratings: z
          .array(
            z.object({
              member: MEMBER_REF,
              stars: z.number().int().min(1).max(5),
              comment: z.string().max(1000).optional(),
            })
          )
          .optional(),
      },
    },
    async ({ recipe, date, eaters, notes, ratings }) =>
      guard(async () => {
        // Resolve every name before writing anything.
        await store.resolveMembers([
          ...(eaters ?? []),
          ...(ratings ?? []).map((r) => r.member),
        ]);
        const cook = await store.logCook(recipe, {
          cookedOn: date ?? s.today(),
          eaters: eaters ?? [],
          notes,
        });
        for (const r of ratings ?? [])
          await store.rate(cook.recipeId, r.member, r.stars, r.comment);
        return json({ logged: cook, ratings: ratings ?? [] });
      })
  );

  server.registerTool(
    'what_to_cook',
    {
      title: 'Recommend what to cook',
      description:
        'Rank saved recipes for the people eating. Each eater counts with their rating, or (unrated) their own average shrunk toward 3.5; a recipe anyone eating rated 2 or lower is dropped (includeVetoed keeps it, flagged); disagreement costs a little; recipes made recently are pushed down (fading over a few weeks); recipes nobody eating has rated get a small bonus. Each result says why.',
      inputSchema: {
        eaters: z
          .array(MEMBER_REF)
          .optional()
          .describe('Who is eating; default every active member'),
        maxMinutes: z.number().int().positive().optional(),
        tags: z.array(z.string()).optional().describe('Must have all of these'),
        excludeTags: z
          .array(z.string())
          .optional()
          .describe('Must have none of these'),
        includeVetoed: z.boolean().optional(),
        limit: z.number().int().min(1).max(50).optional().describe('Default 5'),
      },
    },
    async ({ eaters, maxMinutes, tags, excludeTags, includeVetoed, limit }) =>
      guard(async () => {
        const data = await store.recommendData();
        const who = eaters?.length
          ? await store.resolveMembers(eaters)
          : data.members.filter((m) => m.active);
        if (!who.length)
          return fail('No family members yet; add_member first.');
        const recs = recommend(
          data,
          {
            eaters: who.map((m) => m._id),
            maxMinutes,
            tags,
            excludeTags,
            includeVetoed,
            limit: limit ?? 5,
            today: s.today(),
          },
          s.recommend
        );
        return json({
          eaters: who.map((m) => m.name),
          today: s.today(),
          recommendations: recs.map((r) => ({ ...r, link: link(r.recipeId) })),
        });
      })
  );

  return server;
}
