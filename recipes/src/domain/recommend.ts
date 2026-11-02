import { daysBetween } from '../util/date.js';
import {
  totalMinutesOf,
  type Cook,
  type Member,
  type Rating,
  type Recipe,
} from './types.js';

// "What should we cook?": pure ranking of saved recipes for the people
// eating tonight. Constants live in config (`recommend`).

export interface RecommendParams {
  neutral: number;
  priorWeight: number;
  vetoAt: number;
  spreadPenalty: number;
  recencyPenalty: number;
  recencyDays: number;
  newBonus: number;
}

export interface RecommendQuery {
  /** Member ids eating; all of them must be in `members`. */
  eaters: string[];
  maxMinutes?: number;
  /** Recipe must have every one of these tags. */
  tags?: string[];
  /** Recipe must have none of these tags. */
  excludeTags?: string[];
  /** Keep vetoed recipes (flagged) instead of dropping them. */
  includeVetoed?: boolean;
  limit: number;
  /** Local date, YYYY-MM-DD. */
  today: string;
}

export interface EaterScore {
  memberId: string;
  name: string;
  /** Their rating, or null when unrated. */
  stars: number | null;
  /** The value used: stars, or their shrunk mean when unrated. */
  used: number;
}

export interface Recommendation {
  recipeId: string;
  title: string;
  score: number;
  /** Mean of `used` over eaters minus the disagreement penalty. */
  family: number;
  eaters: EaterScore[];
  lastCooked: string | null;
  daysSince: number | null;
  vetoed: boolean;
  reasons: string[];
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * A member's expected rating for something they haven't rated: their mean,
 * shrunk toward `neutral` as if they had `priorWeight` ratings of it.
 * (sum + k*neutral) / (n + k).
 */
export function memberPrior(
  stars: number[],
  p: Pick<RecommendParams, 'neutral' | 'priorWeight'>
): number {
  const sum = stars.reduce((a, b) => a + b, 0);
  return (sum + p.priorWeight * p.neutral) / (stars.length + p.priorWeight);
}

export function recommend(
  data: {
    recipes: Recipe[];
    ratings: Rating[];
    cooks: Cook[];
    members: Member[];
  },
  q: RecommendQuery,
  p: RecommendParams
): Recommendation[] {
  const memberById = new Map(data.members.map((m) => [m._id, m]));
  const eaters = q.eaters.map((id) => {
    const m = memberById.get(id);
    if (!m) throw new Error(`Unknown member id: ${id}`);
    return m;
  });
  if (!eaters.length) return [];

  const byMember = new Map<string, number[]>();
  const rating = new Map<string, number>();
  for (const r of data.ratings) {
    rating.set(`${r.recipeId}:${r.memberId}`, r.stars);
    byMember.set(r.memberId, [...(byMember.get(r.memberId) ?? []), r.stars]);
  }
  const prior = new Map(
    eaters.map((m) => [m._id, memberPrior(byMember.get(m._id) ?? [], p)])
  );
  const lastCooked = new Map<string, string>();
  for (const c of data.cooks) {
    const prev = lastCooked.get(c.recipeId);
    if (!prev || c.cookedOn > prev) lastCooked.set(c.recipeId, c.cookedOn);
  }

  const want = (q.tags ?? []).map((t) => t.toLowerCase());
  const avoid = (q.excludeTags ?? []).map((t) => t.toLowerCase());

  const out: Recommendation[] = [];
  for (const recipe of data.recipes) {
    if (!want.every((t) => recipe.tags.includes(t))) continue;
    if (avoid.some((t) => recipe.tags.includes(t))) continue;
    const minutes = totalMinutesOf(recipe);
    // An unknown time can't be shown to fit, so it is left out.
    if (q.maxMinutes != null && (minutes == null || minutes > q.maxMinutes))
      continue;

    const scores: EaterScore[] = eaters.map((m) => {
      const stars = rating.get(`${recipe._id}:${m._id}`) ?? null;
      return {
        memberId: m._id,
        name: m.name,
        stars,
        used: stars ?? prior.get(m._id)!,
      };
    });
    const rated = scores.filter((s) => s.stars != null);
    const vetoers = rated.filter((s) => s.stars! <= p.vetoAt);
    const vetoed = vetoers.length > 0;
    if (vetoed && !q.includeVetoed) continue;

    const used = scores.map((s) => s.used);
    const mean = used.reduce((a, b) => a + b, 0) / used.length;
    const spread = Math.max(...used) - Math.min(...used);
    const family = mean - p.spreadPenalty * spread;

    const last = lastCooked.get(recipe._id) ?? null;
    const days = last ? Math.max(0, daysBetween(last, q.today)) : null;
    const recency =
      days == null ? 0 : p.recencyPenalty * Math.exp(-days / p.recencyDays);
    const isNew = rated.length === 0;
    const score = family - recency + (isNew ? p.newBonus : 0);

    const reasons: string[] = [];
    if (vetoed)
      reasons.push(
        `vetoed: ${vetoers.map((s) => `${s.name} ${s.stars}★`).join(', ')}`
      );
    if (isNew) reasons.push('nobody eating has rated it yet');
    else if (
      rated.length === scores.length &&
      rated.every((s) => s.stars! >= 4)
    )
      reasons.push(
        scores.length === 1
          ? `${rated[0]!.name} rated it ${rated[0]!.stars}★`
          : `all ${scores.length} rated it ≥4★`
      );
    else
      reasons.push(
        scores
          .map((s) =>
            s.stars != null
              ? `${s.name} ${s.stars}★`
              : `${s.name} unrated (~${s.used.toFixed(1)})`
          )
          .join(', ')
      );
    reasons.push(
      days == null
        ? 'never made'
        : days === 0
          ? 'made today'
          : `last made ${days} day${days === 1 ? '' : 's'} ago`
    );
    if (minutes != null) reasons.push(`${minutes} min`);

    out.push({
      recipeId: recipe._id,
      title: recipe.title,
      score: round2(score),
      family: round2(family),
      eaters: scores.map((s) => ({ ...s, used: round2(s.used) })),
      lastCooked: last,
      daysSince: days,
      vetoed,
      reasons,
    });
  }
  // Highest score first; ties go to the one made longest ago, then by title.
  out.sort(
    (a, b) =>
      b.score - a.score ||
      (b.daysSince ?? Infinity) - (a.daysSince ?? Infinity) ||
      a.title.localeCompare(b.title)
  );
  return out.slice(0, q.limit);
}
