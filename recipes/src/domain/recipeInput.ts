import { z } from 'zod';
import { normalizeTags } from './slug.js';
import type { RecipeFields } from './types.js';

// The single validated shape for recipe content from MCP, the web form and
// URL import. Optional text that is blank is dropped.

const text = (max: number) =>
  z
    .string()
    .max(max)
    .transform((s) => s.trim())
    .transform((s) => (s ? s : undefined));
const minutes = z
  .number()
  .int()
  .min(0)
  .max(7 * 24 * 60);
const lines = (max: number) =>
  z
    .array(z.string().max(2000))
    .max(max)
    .transform((xs) => xs.map((x) => x.trim()).filter(Boolean));

export const recipeFieldShape = {
  title: z.string().trim().min(1).max(200).describe('Recipe name'),
  description: text(2000).optional().describe('One or two sentences'),
  sourceUrl: z
    .url({ protocol: /^https?$/ })
    .max(2000)
    .optional()
    .describe('Page the recipe came from'),
  imageUrl: z
    .url({ protocol: /^https?$/ })
    .max(2000)
    .optional(),
  servings: text(100).optional().describe('As written, e.g. "4" or "6-8"'),
  prepMinutes: minutes.optional(),
  cookMinutes: minutes.optional(),
  totalMinutes: minutes
    .optional()
    .describe('Total time; defaults to prep + cook when both are given'),
  ingredients: lines(200).describe(
    'One line per ingredient as written, e.g. "2 cups flour"'
  ),
  steps: lines(200).describe(
    'One entry per step; a short entry ending in ":" is a section heading'
  ),
  tags: z
    .array(z.string())
    .max(30)
    .transform(normalizeTags)
    .describe(
      'Lowercase tags, e.g. "chicken", "weeknight", "vegetarian", "slow cooker"'
    ),
  cuisine: text(100).optional().describe('e.g. "Mexican"'),
  course: text(100).optional().describe('e.g. "dinner", "dessert", "side"'),
  notes: text(4000).optional().describe("The family's own notes and tweaks"),
};

export const recipeFieldsSchema = z.object({
  ...recipeFieldShape,
  ingredients: recipeFieldShape.ingredients.default([]),
  steps: recipeFieldShape.steps.default([]),
  tags: recipeFieldShape.tags.default([]),
});

/** Every field optional: a partial update or overrides on an import. */
export const recipePatchSchema = z.object(recipeFieldShape).partial();

export type RecipePatch = z.infer<typeof recipePatchSchema>;

/** Drop undefined keys so they never overwrite stored values. */
export function compact<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined)
  ) as Partial<T>;
}

export function parseRecipeFields(input: unknown): RecipeFields {
  return compact(recipeFieldsSchema.parse(input)) as RecipeFields;
}
