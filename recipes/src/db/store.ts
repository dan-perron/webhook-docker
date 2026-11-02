import { randomUUID } from 'node:crypto';
import { MongoServerError, type Collection, type Db } from 'mongodb';
import {
  compact,
  parseRecipeFields,
  recipePatchSchema,
} from '../domain/recipeInput.js';
import { normalizeName, slugify, sourceKeyOf } from '../domain/slug.js';
import {
  totalMinutesOf,
  type Cook,
  type CreatedVia,
  type Member,
  type Rating,
  type Recipe,
  type RecipeFields,
} from '../domain/types.js';
import { isIsoDate } from '../util/date.js';

// Recipes, members, ratings and the cook log on the shared Mongo (database
// `recipes`). Mongo is standalone (no transactions): every write here is a
// single-document operation, and removing a recipe deletes its ratings and
// cooks afterwards (orphans are ignored by readers anyway).

/** A user-facing problem (bad name, duplicate...): shown as-is. */
export class StoreError extends Error {
  constructor(
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

const isDuplicateKey = (e: unknown) =>
  e instanceof MongoServerError && e.code === 11000;

/** Summary used in lists, search results and duplicate reports. */
export interface RecipeSummary {
  id: string;
  title: string;
  tags: string[];
  totalMinutes?: number;
  sourceUrl?: string;
  /** Mean stars over everyone who rated it, 1 decimal. */
  avgStars: number | null;
  ratings: number;
  lastCooked: string | null;
  timesCooked: number;
}

export class RecipeStore {
  readonly members: Collection<Member>;
  readonly recipes: Collection<Recipe>;
  readonly ratings: Collection<Rating>;
  readonly cooks: Collection<Cook>;

  constructor(
    db: Db,
    private readonly now: () => Date = () => new Date()
  ) {
    this.members = db.collection('members');
    this.recipes = db.collection('recipes');
    this.ratings = db.collection('ratings');
    this.cooks = db.collection('cooks');
  }

  async ensureIndexes() {
    await Promise.all([
      this.recipes.createIndex(
        { sourceKey: 1 },
        {
          unique: true,
          partialFilterExpression: { sourceKey: { $type: 'string' } },
        }
      ),
      this.ratings.createIndex({ recipeId: 1 }),
      this.ratings.createIndex({ memberId: 1 }),
      this.cooks.createIndex({ recipeId: 1, cookedOn: -1 }),
    ]);
  }

  // ---- members ----

  listMembers(opts: { activeOnly?: boolean } = {}) {
    return this.members
      .find(opts.activeOnly ? { active: true } : {})
      .sort({ createdAt: 1 })
      .toArray();
  }

  async addMember(name: string): Promise<Member> {
    const clean = name.trim().replace(/\s+/g, ' ');
    if (!clean || clean.length > 40)
      throw new StoreError('A member name is 1-40 characters.');
    const member: Member = {
      _id: slugify(clean, 40),
      name: clean,
      active: true,
      createdAt: this.now(),
    };
    try {
      await this.members.insertOne(member);
    } catch (e) {
      if (isDuplicateKey(e))
        throw new StoreError(`${clean} is already a member.`);
      throw e;
    }
    return member;
  }

  async updateMember(
    ref: string,
    patch: { name?: string; active?: boolean }
  ): Promise<Member> {
    const m = await this.resolveMember(ref);
    const set: Partial<Member> = {};
    if (patch.name != null) {
      const clean = patch.name.trim().replace(/\s+/g, ' ');
      if (!clean || clean.length > 40)
        throw new StoreError('A member name is 1-40 characters.');
      const clash = (await this.listMembers()).find(
        (o) => o._id !== m._id && normalizeName(o.name) === normalizeName(clean)
      );
      if (clash) throw new StoreError(`${clash.name} is already a member.`);
      set.name = clean;
    }
    if (patch.active != null) set.active = patch.active;
    // The id stays the same so ratings keep pointing at it.
    await this.members.updateOne({ _id: m._id }, { $set: set });
    return { ...m, ...set };
  }

  /** A member by id or name (case/accent-insensitive). */
  async resolveMember(ref: string): Promise<Member> {
    const all = await this.listMembers();
    const key = normalizeName(ref);
    const m = all.find((x) => x._id === ref || normalizeName(x.name) === key);
    if (m) return m;
    throw new StoreError(
      all.length
        ? `No family member named "${ref}". Members: ${all.map((x) => x.name).join(', ')}.`
        : `No family members yet; add one first (e.g. "${ref}").`
    );
  }

  async resolveMembers(refs: string[]): Promise<Member[]> {
    const out: Member[] = [];
    for (const r of refs) {
      const m = await this.resolveMember(r);
      if (!out.some((x) => x._id === m._id)) out.push(m);
    }
    return out;
  }

  // ---- recipes ----

  getRecipe(id: string) {
    return this.recipes.findOne({ _id: id });
  }

  /** A recipe by id or exact title; otherwise lists close matches. */
  async resolveRecipe(ref: string): Promise<Recipe> {
    const byId = await this.getRecipe(ref);
    if (byId) return byId;
    const all = await this.recipes.find().toArray();
    const key = normalizeName(ref);
    const exact = all.filter((r) => normalizeName(r.title) === key);
    if (exact.length === 1) return exact[0]!;
    const close = (exact.length ? exact : all)
      .filter((r) => exact.length || normalizeName(r.title).includes(key))
      .sort((a, b) => a.title.localeCompare(b.title))
      .slice(0, 8)
      .map((r) => `${r.title} (id ${r._id})`);
    throw new StoreError(
      close.length
        ? `"${ref}" matches more than one recipe or none exactly. Did you mean: ${close.join('; ')}?`
        : `No recipe "${ref}".`
    );
  }

  /** An existing recipe with the same source page or title, if any. */
  async findDuplicate(fields: Pick<RecipeFields, 'title' | 'sourceUrl'>) {
    const key = fields.sourceUrl ? sourceKeyOf(fields.sourceUrl) : undefined;
    if (key) {
      const r = await this.recipes.findOne({ sourceKey: key });
      if (r) return { recipe: r, reason: 'same source page' as const };
    }
    const title = normalizeName(fields.title);
    const r = (await this.recipes.find().toArray()).find(
      (x) => normalizeName(x.title) === title
    );
    return r ? { recipe: r, reason: 'same title' as const } : undefined;
  }

  async addRecipe(
    input: unknown,
    via: CreatedVia,
    opts: { allowDuplicateTitle?: boolean } = {}
  ): Promise<Recipe> {
    const fields = parseRecipeFields(input);
    const dup = await this.findDuplicate(fields);
    if (dup && (dup.reason === 'same source page' || !opts.allowDuplicateTitle))
      throw new StoreError(
        `Already saved (${dup.reason}): ${dup.recipe.title} (id ${dup.recipe._id}).`,
        { duplicateOf: dup.recipe._id, reason: dup.reason }
      );
    const now = this.now();
    const sourceKey = fields.sourceUrl
      ? sourceKeyOf(fields.sourceUrl)
      : undefined;
    const base = slugify(fields.title);
    for (let n = 1; n < 100; n++) {
      const recipe: Recipe = {
        ...fields,
        _id: n === 1 ? base : `${base}-${n}`,
        ...(sourceKey ? { sourceKey } : {}),
        createdVia: via,
        createdAt: now,
        updatedAt: now,
      };
      try {
        await this.recipes.insertOne(recipe);
        return recipe;
      } catch (e) {
        if (!isDuplicateKey(e)) throw e;
        // Lost a race on the source page: report it like findDuplicate.
        if (sourceKey && (await this.recipes.findOne({ sourceKey })))
          throw new StoreError('Already saved (same source page).');
      }
    }
    throw new StoreError('Could not pick an id for this recipe.');
  }

  /**
   * Partial update. Arrays replace; `null` (web form: blank) clears an
   * optional field. The id never changes, so links keep working.
   */
  async updateRecipe(ref: string, patch: unknown): Promise<Recipe> {
    const current = await this.resolveRecipe(ref);
    const raw = (patch ?? {}) as Record<string, unknown>;
    const cleared = Object.keys(raw).filter(
      (k) => raw[k] === null && k !== 'title'
    );
    const parsed = compact(
      recipePatchSchema.parse(
        Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null))
      )
    );
    const next = { ...current, ...parsed } as Recipe;
    for (const k of cleared)
      delete (next as unknown as Record<string, unknown>)[k];
    // Validate the merged result as a whole.
    const fields = parseRecipeFields(next);
    const sourceKey = fields.sourceUrl
      ? sourceKeyOf(fields.sourceUrl)
      : undefined;
    if (sourceKey && sourceKey !== current.sourceKey) {
      const other = await this.recipes.findOne({ sourceKey });
      if (other && other._id !== current._id)
        throw new StoreError(
          `Another recipe already uses that source: ${other.title} (id ${other._id}).`
        );
    }
    const doc: Recipe = {
      ...fields,
      _id: current._id,
      ...(sourceKey ? { sourceKey } : {}),
      createdVia: current.createdVia,
      createdAt: current.createdAt,
      updatedAt: this.now(),
    };
    await this.recipes.replaceOne({ _id: current._id }, doc);
    return doc;
  }

  async removeRecipe(ref: string): Promise<Recipe> {
    const r = await this.resolveRecipe(ref);
    await this.recipes.deleteOne({ _id: r._id });
    await this.ratings.deleteMany({ recipeId: r._id });
    await this.cooks.deleteMany({ recipeId: r._id });
    return r;
  }

  // ---- ratings & cooks ----

  async rate(
    recipeRef: string,
    memberRef: string,
    stars: number,
    comment?: string
  ): Promise<Rating> {
    if (!Number.isInteger(stars) || stars < 1 || stars > 5)
      throw new StoreError('Stars are a whole number from 1 to 5.');
    const recipe = await this.resolveRecipe(recipeRef);
    const member = await this.resolveMember(memberRef);
    const rating: Rating = {
      _id: `${recipe._id}:${member._id}`,
      recipeId: recipe._id,
      memberId: member._id,
      stars,
      ...(comment?.trim() ? { comment: comment.trim().slice(0, 1000) } : {}),
      ratedAt: this.now(),
    };
    await this.ratings.replaceOne({ _id: rating._id }, rating, {
      upsert: true,
    });
    return rating;
  }

  async unrate(recipeRef: string, memberRef: string) {
    const recipe = await this.resolveRecipe(recipeRef);
    const member = await this.resolveMember(memberRef);
    await this.ratings.deleteOne({ _id: `${recipe._id}:${member._id}` });
  }

  async logCook(
    recipeRef: string,
    p: { cookedOn: string; eaters: string[]; notes?: string }
  ): Promise<Cook> {
    if (!isIsoDate(p.cookedOn))
      throw new StoreError('Date must be YYYY-MM-DD.');
    const recipe = await this.resolveRecipe(recipeRef);
    const eaters = p.eaters.length
      ? await this.resolveMembers(p.eaters)
      : await this.listMembers({ activeOnly: true });
    const cook: Cook = {
      _id: randomUUID(),
      recipeId: recipe._id,
      cookedOn: p.cookedOn,
      eaters: eaters.map((m) => m._id),
      ...(p.notes?.trim() ? { notes: p.notes.trim().slice(0, 1000) } : {}),
      createdAt: this.now(),
    };
    await this.cooks.insertOne(cook);
    return cook;
  }

  async removeCook(id: string) {
    await this.cooks.deleteOne({ _id: id });
  }

  /** Everything about one recipe, with member names. */
  async recipeDetail(ref: string) {
    const recipe = await this.resolveRecipe(ref);
    const [members, ratings, cooks] = await Promise.all([
      this.listMembers(),
      this.ratings.find({ recipeId: recipe._id }).toArray(),
      this.cooks
        .find({ recipeId: recipe._id })
        .sort({ cookedOn: -1 })
        .toArray(),
    ]);
    const name = new Map(members.map((m) => [m._id, m.name]));
    return {
      recipe,
      members,
      ratings: ratings.map((r) => ({
        ...r,
        member: name.get(r.memberId) ?? r.memberId,
      })),
      cooks: cooks.map((c) => ({
        ...c,
        eaterNames: c.eaters.map((id) => name.get(id) ?? id),
      })),
    };
  }

  /** Summaries for every recipe (the collection is family-sized). */
  async summaries(recipes?: Recipe[]): Promise<RecipeSummary[]> {
    const [all, ratings, cooks] = await Promise.all([
      recipes ?? this.recipes.find().toArray(),
      this.ratings.find().toArray(),
      this.cooks.find().toArray(),
    ]);
    const stars = new Map<string, number[]>();
    for (const r of ratings)
      stars.set(r.recipeId, [...(stars.get(r.recipeId) ?? []), r.stars]);
    const made = new Map<string, string[]>();
    for (const c of cooks)
      made.set(c.recipeId, [...(made.get(c.recipeId) ?? []), c.cookedOn]);
    return all.map((r) => {
      const s = stars.get(r._id) ?? [];
      const m = made.get(r._id) ?? [];
      const total = totalMinutesOf(r);
      return {
        id: r._id,
        title: r.title,
        tags: r.tags,
        ...(total != null ? { totalMinutes: total } : {}),
        ...(r.sourceUrl ? { sourceUrl: r.sourceUrl } : {}),
        avgStars: s.length
          ? Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 10) / 10
          : null,
        ratings: s.length,
        lastCooked: m.length ? m.sort().at(-1)! : null,
        timesCooked: m.length,
      };
    });
  }

  /**
   * Search by words (all must appear in the title, tags, ingredients,
   * cuisine, course or description), tag, ingredient and time.
   * Title matches rank first.
   */
  async search(q: {
    text?: string;
    tag?: string;
    ingredient?: string;
    maxMinutes?: number;
    limit?: number;
  }): Promise<RecipeSummary[]> {
    const all = await this.recipes.find().toArray();
    const words = (q.text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const tag = q.tag?.trim().toLowerCase();
    const ing = q.ingredient?.trim().toLowerCase();
    const scored: { r: Recipe; rank: number }[] = [];
    for (const r of all) {
      if (tag && !r.tags.includes(tag)) continue;
      if (ing && !r.ingredients.some((i) => i.toLowerCase().includes(ing)))
        continue;
      if (q.maxMinutes != null) {
        const total = totalMinutesOf(r);
        if (total == null || total > q.maxMinutes) continue;
      }
      const title = r.title.toLowerCase();
      const hay = [
        title,
        r.tags.join(' '),
        r.ingredients.join(' '),
        r.cuisine ?? '',
        r.course ?? '',
        r.description ?? '',
      ]
        .join(' \n ')
        .toLowerCase();
      if (!words.every((w) => hay.includes(w))) continue;
      scored.push({ r, rank: words.filter((w) => title.includes(w)).length });
    }
    scored.sort(
      (a, b) => b.rank - a.rank || a.r.title.localeCompare(b.r.title)
    );
    return this.summaries(scored.slice(0, q.limit ?? 50).map((x) => x.r));
  }

  /** Everything the recommender reads. */
  async recommendData() {
    const [recipes, ratings, cooks, members] = await Promise.all([
      this.recipes.find().toArray(),
      this.ratings.find().toArray(),
      this.cooks.find().toArray(),
      this.listMembers(),
    ]);
    return { recipes, ratings, cooks, members };
  }

  /** Every tag in use, most used first. */
  async tagCounts(): Promise<{ tag: string; count: number }[]> {
    const counts = new Map<string, number>();
    for (const r of await this.recipes
      .find({}, { projection: { tags: 1 } })
      .toArray())
      for (const t of r.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }
}
