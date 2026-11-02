/** A family member who eats and rates. `_id` is a slug of the name. */
export interface Member {
  _id: string;
  name: string;
  /** Inactive members keep their ratings but are not default eaters. */
  active: boolean;
  createdAt: Date;
}

export const CREATED_VIA = ['mcp', 'web'] as const;
export type CreatedVia = (typeof CREATED_VIA)[number];

/** Editable recipe content: what MCP, the web form and URL import produce. */
export interface RecipeFields {
  title: string;
  description?: string;
  sourceUrl?: string;
  imageUrl?: string;
  /** As written: "4", "4-6 servings", "1 loaf". */
  servings?: string;
  prepMinutes?: number;
  cookMinutes?: number;
  totalMinutes?: number;
  /** One ingredient line each, as written ("2 cups flour"). */
  ingredients: string[];
  /** One step each. A step ending in ':' is a section heading. */
  steps: string[];
  /** Lowercase, deduplicated. */
  tags: string[];
  cuisine?: string;
  course?: string;
  notes?: string;
}

export interface Recipe extends RecipeFields {
  /** Slug of the title, unique (`-2`, `-3` on collisions). */
  _id: string;
  /** Normalized sourceUrl, unique: the same page is never added twice. */
  sourceKey?: string;
  createdVia: CreatedVia;
  createdAt: Date;
  updatedAt: Date;
}

/** One member's current rating of one recipe; rating again replaces it. */
export interface Rating {
  _id: string; // `${recipeId}:${memberId}`
  recipeId: string;
  memberId: string;
  /** 1..5 */
  stars: number;
  comment?: string;
  ratedAt: Date;
}

/** "We made it": the log the recommender reads for recency. */
export interface Cook {
  _id: string;
  recipeId: string;
  /** Local calendar date, YYYY-MM-DD. */
  cookedOn: string;
  /** Member ids who ate it. */
  eaters: string[];
  notes?: string;
  createdAt: Date;
}

/** Total time: stated, or prep + cook when both are known. */
export function totalMinutesOf(r: RecipeFields): number | undefined {
  if (r.totalMinutes != null) return r.totalMinutes;
  if (r.prepMinutes != null && r.cookMinutes != null)
    return r.prepMinutes + r.cookMinutes;
  return undefined;
}
