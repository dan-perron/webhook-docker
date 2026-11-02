import { normalizeTags } from '../domain/slug.js';
import type { RecipeFields } from '../domain/types.js';

// schema.org Recipe JSON-LD -> RecipeFields. Most recipe sites embed one in a
// <script type="application/ld+json">, at the top level, in an array, in an
// @graph, or as a WebPage's mainEntity. Never fetches; see fetchPage.ts.

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

const isObj = (x: Json | undefined): x is Obj =>
  !!x && typeof x === 'object' && !Array.isArray(x);

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  deg: '°',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code =
        e[1] === 'x' || e[1] === 'X'
          ? parseInt(e.slice(2), 16)
          : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Plain text: entities decoded (twice: some sites double-encode), tags stripped. */
export function clean(s: string): string {
  return decodeEntities(decodeEntities(s))
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const str = (x: Json | undefined): string | undefined => {
  if (typeof x === 'string') return clean(x) || undefined;
  if (typeof x === 'number') return String(x);
  if (Array.isArray(x)) {
    for (const v of x) {
      const s = str(v);
      if (s) return s;
    }
  }
  return undefined;
};

const strs = (x: Json | undefined): string[] =>
  x == null
    ? []
    : Array.isArray(x)
      ? x.flatMap(strs)
      : typeof x === 'string'
        ? [clean(x)].filter(Boolean)
        : [];

/** ISO 8601 duration ("PT1H30M", "P0DT0H45M", "PT90M") -> minutes. */
export function durationMinutes(x: Json | undefined): number | undefined {
  if (typeof x !== 'string') return undefined;
  const m = x
    .trim()
    .match(
      /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i
    );
  if (!m || !(m[1] || m[2] || m[3] || m[4])) return undefined;
  const [d, h, min, s] = [m[1], m[2], m[3], m[4]].map((v) => Number(v ?? 0));
  const total = Math.round(d! * 1440 + h! * 60 + min! + s! / 60);
  return total > 0 ? total : undefined;
}

const types = (o: Obj): string[] =>
  strs(o['@type']).map((t) => t.toLowerCase());

/** Depth-first search for the first object typed Recipe. */
export function findRecipe(x: Json, depth = 0): Obj | undefined {
  if (depth > 6 || x == null || typeof x !== 'object') return undefined;
  if (Array.isArray(x)) {
    for (const v of x) {
      const r = findRecipe(v, depth + 1);
      if (r) return r;
    }
    return undefined;
  }
  if (types(x).includes('recipe')) return x;
  for (const k of [
    '@graph',
    'mainEntity',
    'mainEntityOfPage',
    'itemListElement',
  ]) {
    const r = findRecipe(x[k] ?? null, depth + 1);
    if (r) return r;
  }
  return undefined;
}

/** recipeInstructions: text, HowToStep(s), HowToSection(s), or a mix. */
function instructions(x: Json | undefined): string[] {
  if (x == null) return [];
  if (typeof x === 'string') {
    // One block of text: split on line breaks, else keep whole.
    return x
      .split(/\r?\n|<br\s*\/?>|<\/p>|<\/li>/i)
      .map(clean)
      .filter(Boolean);
  }
  if (Array.isArray(x)) return x.flatMap(instructions);
  if (!isObj(x)) return [];
  const t = types(x);
  if (t.includes('howtosection') || (x.itemListElement && !x.text)) {
    const heading = str(x.name);
    const steps = instructions(x.itemListElement);
    return heading ? [`${heading.replace(/:$/, '')}:`, ...steps] : steps;
  }
  const text = str(x.text) ?? str(x.name) ?? str(x.description);
  return text ? [text] : [];
}

function image(x: Json | undefined): string | undefined {
  if (typeof x === 'string') return x.trim() || undefined;
  if (Array.isArray(x)) {
    for (const v of x) {
      const u = image(v);
      if (u) return u;
    }
    return undefined;
  }
  if (isObj(x)) return image(x.url ?? x.contentUrl ?? null);
  return undefined;
}

const httpUrl = (u: string | undefined, base?: string) => {
  if (!u) return undefined;
  try {
    const parsed = new URL(u, base);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
};

/** recipeYield is "4", 4, "4 servings", or ["4", "4 servings"]. */
function servings(x: Json | undefined): string | undefined {
  const all = Array.isArray(x) ? x.map(str).filter(Boolean) : [str(x)];
  // Prefer the most descriptive form.
  return (all as string[]).sort((a, b) => b.length - a.length)[0];
}

/** Split "a, b; c" lists (keywords, categories) into items. */
const listItems = (x: Json | undefined): string[] =>
  (typeof x === 'string' ? [x] : strs(x))
    .flatMap((v) => v.split(/[,;]/))
    .map(clean)
    .filter(Boolean);

function authorNames(x: Json | undefined): string[] {
  if (Array.isArray(x)) return x.flatMap(authorNames);
  if (isObj(x)) return strs(x.name);
  return strs(x);
}

/**
 * Keywords make poor tags as-is: SEO phrases repeat the title ("homemade
 * vegetable soup recipe"), some sites list the author, and the course or
 * cuisine is already its own field. Keep the short, distinct ones.
 */
function keywordTags(
  keywords: string[],
  title: string,
  skip: (string | undefined)[]
): string[] {
  const t = title.toLowerCase();
  const drop = skip.filter(Boolean).map((x) => x!.toLowerCase());
  return normalizeTags(keywords).filter(
    (k) =>
      k.length <= 25 &&
      k.split(' ').length <= 3 &&
      !k.includes('recipe') &&
      !k.includes(t) &&
      !drop.includes(k)
  );
}

/** Drop cost annotations some sites put on ingredients: "1 onion ($0.32)". */
const ingredientLine = (s: string) =>
  s.replace(/\s*\(\$\s?\d+(?:\.\d+)?\)/g, '').trim();

/** Map a schema.org Recipe object to recipe fields. */
export function recipeFromJsonLd(o: Obj, pageUrl?: string): RecipeFields {
  const title = str(o.name) ?? str(o.headline) ?? 'Untitled recipe';
  // recipeCategory is often a list ("Dinner, Kid-Friendly, Main Course"):
  // the first is the course, the rest are tag candidates.
  const [course, ...moreCategories] = listItems(o.recipeCategory);
  const [cuisine] = listItems(o.recipeCuisine);
  return {
    title,
    description: str(o.description),
    sourceUrl: httpUrl(pageUrl) ?? httpUrl(str(o.url)),
    imageUrl: httpUrl(image(o.image), pageUrl),
    servings: servings(o.recipeYield),
    prepMinutes: durationMinutes(o.prepTime),
    cookMinutes: durationMinutes(o.cookTime),
    totalMinutes: durationMinutes(o.totalTime),
    ingredients: strs(o.recipeIngredient ?? o.ingredients)
      .map(ingredientLine)
      .filter(Boolean),
    steps: instructions(o.recipeInstructions),
    tags: keywordTags([...moreCategories, ...listItems(o.keywords)], title, [
      ...authorNames(o.author),
      course,
      cuisine,
    ]).slice(0, 8),
    cuisine,
    course,
  };
}

const LD_JSON =
  /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;

/** Lenient JSON.parse for hand-built ld+json (comments, raw newlines). */
function parseLoose(text: string): Json | undefined {
  const body = text
    .trim()
    .replace(/^<!\[CDATA\[|\]\]>$/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  try {
    return JSON.parse(body) as Json;
  } catch {
    try {
      // Raw control characters inside strings are the usual culprit.
      // eslint-disable-next-line no-control-regex
      return JSON.parse(body.replace(/[\u0000-\u001f]+/g, ' ')) as Json;
    } catch {
      return undefined;
    }
  }
}

export class NoRecipeFound extends Error {}

/** Find and map the page's schema.org Recipe; throws NoRecipeFound. */
export function recipeFromHtml(html: string, pageUrl?: string): RecipeFields {
  for (const m of html.matchAll(LD_JSON)) {
    const data = parseLoose(m[1] ?? '');
    const recipe = data == null ? undefined : findRecipe(data);
    if (recipe) {
      const fields = recipeFromJsonLd(recipe, pageUrl);
      return Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== undefined)
      ) as unknown as RecipeFields;
    }
  }
  throw new NoRecipeFound(
    'No schema.org Recipe data on that page. Enter it by hand (or paste the text to Claude).'
  );
}
