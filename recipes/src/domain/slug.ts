/** URL-safe id from a title or name: "Crème Brûlée!" -> "creme-brulee". */
export function slugify(s: string, max = 60): string {
  const slug = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
  return slug || 'recipe';
}

/** Case/spacing/accent-insensitive form for comparing names and titles. */
export const normalizeName = (s: string) => slugify(s, 200);

// Tracking parameters dropped when comparing source URLs.
const TRACKING = /^(utm_|fbclid$|gclid$|mc_|ref$|ref_src$|s$|amp$)/i;

/**
 * Comparable form of a recipe URL: host without www, no scheme, fragment,
 * tracking params or trailing slash. Two links to the same page match.
 */
export function sourceKeyOf(raw: string): string | undefined {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING.test(k))
    .sort(([a], [b]) => a.localeCompare(b));
  const query = params.length ? `?${new URLSearchParams(params)}` : '';
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const path = u.pathname.replace(/\/+$/, '') || '/';
  return `${host}${path}${query}`;
}

/** Tags as stored: trimmed, lowercase, unique, non-empty. */
export function normalizeTags(tags: Iterable<string>): string[] {
  const out: string[] = [];
  for (const t of tags) {
    const tag = t.trim().toLowerCase().replace(/\s+/g, ' ');
    if (tag && tag.length <= 40 && !out.includes(tag)) out.push(tag);
  }
  return out;
}
