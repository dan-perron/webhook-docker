import type { RecipeSummary } from '../db/store.js';
import type { Recommendation } from '../domain/recommend.js';
import {
  totalMinutesOf,
  type Cook,
  type Member,
  type Rating,
  type Recipe,
  type RecipeFields,
} from '../domain/types.js';
import { url } from '../util/url.js';
import { Layout, Stars, minutesLabel } from './layout.js';

const recipeUrl = (id: string) => url(`/r/${encodeURIComponent(id)}`);

function lastMadeLabel(date: string | null, today: string) {
  if (!date) return 'never made';
  if (date === today) return 'made today';
  const days = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) /
      86_400_000
  );
  return days === 1 ? 'made yesterday' : `made ${days} days ago`;
}

// ---- list ----

export function RecipeCards(props: { items: RecipeSummary[]; today: string }) {
  if (!props.items.length)
    return <p class="empty">No recipes match. Try fewer words.</p>;
  return (
    <ul class="cards">
      {props.items.map((r) => (
        <li>
          <a class="card recipe-card" href={recipeUrl(r.id)}>
            <span class="recipe-card__title">{r.title}</span>
            <span class="recipe-card__meta">
              <Stars value={r.avgStars} />
              {r.ratings ? <span class="muted"> ({r.ratings})</span> : null}
              {r.totalMinutes != null ? (
                <span> · {minutesLabel(r.totalMinutes)}</span>
              ) : null}
              <span> · {lastMadeLabel(r.lastCooked, props.today)}</span>
            </span>
            {r.tags.length ? (
              <span class="chips">
                {r.tags.slice(0, 5).map((t) => (
                  <span class="chip">{t}</span>
                ))}
              </span>
            ) : null}
          </a>
        </li>
      ))}
    </ul>
  );
}

export function ListPage(props: {
  items: RecipeSummary[];
  total: number;
  q: string;
  tag: string;
  tags: { tag: string; count: number }[];
  today: string;
}) {
  return (
    <Layout title="Recipe Box" active="recipes">
      <form
        class="search"
        method="get"
        action={url('/')}
        hx-get={url('/')}
        hx-trigger="input changed delay:250ms from:input, change from:select"
        hx-target="#results"
        hx-select="#results"
        hx-swap="outerHTML"
        hx-push-url="true"
      >
        <input
          type="search"
          name="q"
          value={props.q}
          placeholder={`Search ${props.total} recipe${props.total === 1 ? '' : 's'}`}
          aria-label="Search recipes"
        />
        <select name="tag" aria-label="Tag">
          <option value="">All tags</option>
          {props.tags.map((t) => (
            <option value={t.tag} selected={t.tag === props.tag}>
              {t.tag} ({t.count})
            </option>
          ))}
        </select>
        <noscript>
          <button class="btn" type="submit">
            Search
          </button>
        </noscript>
      </form>
      <div id="results">
        {props.total === 0 ? (
          <section class="card empty-state">
            <p>No recipes yet.</p>
            <p class="muted">
              Ask Claude to add one from a link, or{' '}
              <a href={url('/new')}>add one here</a>.
            </p>
          </section>
        ) : (
          <RecipeCards items={props.items} today={props.today} />
        )}
      </div>
    </Layout>
  );
}

// ---- one recipe ----

export function RatingsBlock(props: {
  recipeId: string;
  members: Member[];
  ratings: Rating[];
}) {
  const shown = props.members.filter(
    (m) => m.active || props.ratings.some((r) => r.memberId === m._id)
  );
  return (
    <section class="card" id="ratings">
      <h2 class="section-title">Ratings</h2>
      {shown.length === 0 ? (
        <p class="muted">
          Add family members on the <a href={url('/family')}>Family</a> page to
          rate.
        </p>
      ) : (
        <ul class="ratings">
          {shown.map((m) => {
            const r = props.ratings.find((x) => x.memberId === m._id);
            return (
              <li class="rating-row">
                <span class="rating-row__name">{m.name}</span>
                <span
                  class="star-picker"
                  role="group"
                  aria-label={`${m.name}'s rating`}
                >
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      type="button"
                      class={`star ${r && n <= r.stars ? 'star--on' : ''}`}
                      aria-label={`${n} star${n === 1 ? '' : 's'}`}
                      aria-pressed={r?.stars === n ? 'true' : 'false'}
                      hx-post={`${recipeUrl(props.recipeId)}/rate`}
                      hx-vals={JSON.stringify({
                        member: m._id,
                        stars: String(n),
                      })}
                      hx-target="#ratings"
                      hx-swap="outerHTML"
                    >
                      ★
                    </button>
                  ))}
                </span>
                {r?.comment ? (
                  <span class="rating-row__comment">“{r.comment}”</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function RecipePage(props: {
  recipe: Recipe;
  members: Member[];
  ratings: Rating[];
  cooks: (Cook & { eaterNames: string[] })[];
  today: string;
}) {
  const r = props.recipe;
  const total = totalMinutesOf(r);
  const times = [
    r.prepMinutes != null ? `Prep ${minutesLabel(r.prepMinutes)}` : null,
    r.cookMinutes != null ? `Cook ${minutesLabel(r.cookMinutes)}` : null,
    total != null ? `Total ${minutesLabel(total)}` : null,
    r.servings ? `Serves ${r.servings}` : null,
  ].filter(Boolean);
  const active = props.members.filter((m) => m.active);
  return (
    <Layout title={`${r.title} — Recipe Box`} active="recipes">
      <article class="card recipe">
        {r.imageUrl ? (
          <img
            class="recipe__image"
            src={r.imageUrl}
            alt=""
            loading="lazy"
            referrerpolicy="no-referrer"
          />
        ) : null}
        <h1 class="recipe__title">{r.title}</h1>
        {r.description ? <p class="muted">{r.description}</p> : null}
        {times.length ? <p class="recipe__times">{times.join(' · ')}</p> : null}
        {r.tags.length || r.cuisine || r.course ? (
          <p class="chips">
            {[r.cuisine, r.course].filter(Boolean).map((t) => (
              <span class="chip chip--alt">{t}</span>
            ))}
            {r.tags.map((t) => (
              <a class="chip" href={`${url('/')}?tag=${encodeURIComponent(t)}`}>
                {t}
              </a>
            ))}
          </p>
        ) : null}
        <p class="recipe__made">
          {lastMadeLabel(props.cooks[0]?.cookedOn ?? null, props.today)}
          {props.cooks.length > 1
            ? ` · ${props.cooks.length} times in all`
            : ''}
        </p>
      </article>

      <RatingsBlock
        recipeId={r._id}
        members={props.members}
        ratings={props.ratings}
      />

      {r.ingredients.length ? (
        <section class="card">
          <h2 class="section-title">Ingredients</h2>
          <ul class="ingredients">
            {r.ingredients.map((i) => (
              <li>{i}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {r.steps.length ? (
        <section class="card">
          <h2 class="section-title">Steps</h2>
          <ol class="steps">
            {r.steps.map((s) =>
              /:$/.test(s) && s.length < 80 ? (
                <li class="steps__heading">{s.replace(/:$/, '')}</li>
              ) : (
                <li>{s}</li>
              )
            )}
          </ol>
        </section>
      ) : null}

      {r.notes ? (
        <section class="card">
          <h2 class="section-title">Our notes</h2>
          <p class="notes">{r.notes}</p>
        </section>
      ) : null}

      <section class="card">
        <h2 class="section-title">Made it</h2>
        <form
          class="made-form"
          method="post"
          action={`${recipeUrl(r._id)}/cooked`}
        >
          <input
            type="date"
            name="date"
            value={props.today}
            max={props.today}
            aria-label="Date made"
            required
          />
          {active.length ? (
            <fieldset class="eaters">
              <legend class="muted">Who ate</legend>
              {active.map((m) => (
                <label class="check">
                  <input type="checkbox" name="eaters" value={m._id} checked />
                  {m.name}
                </label>
              ))}
            </fieldset>
          ) : null}
          <button class="btn btn--primary" type="submit">
            We made this
          </button>
        </form>
        {props.cooks.length ? (
          <ul class="history">
            {props.cooks.slice(0, 10).map((c) => (
              <li>
                <span>{c.cookedOn}</span>
                <span class="muted">{c.eaterNames.join(', ')}</span>
                <form
                  method="post"
                  action={`${recipeUrl(r._id)}/cooked/${encodeURIComponent(c._id)}/delete`}
                >
                  <button
                    class="link-btn"
                    type="submit"
                    aria-label={`Remove ${c.cookedOn}`}
                  >
                    remove
                  </button>
                </form>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section class="actions">
        {r.sourceUrl ? (
          <a
            class="btn"
            href={r.sourceUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            Original page
          </a>
        ) : null}
        <a class="btn" href={`${recipeUrl(r._id)}/edit`}>
          Edit
        </a>
        <form
          method="post"
          action={`${recipeUrl(r._id)}/delete`}
          onsubmit="return confirm('Delete this recipe, its ratings and history?')"
        >
          <button class="btn btn--danger" type="submit">
            Delete
          </button>
        </form>
      </section>
    </Layout>
  );
}

// ---- add / edit ----

export type FormValues = Partial<RecipeFields>;

export function RecipeForm(props: {
  mode: 'new' | 'edit';
  values: FormValues;
  action: string;
  error?: string;
  notice?: string;
  importUrl?: string;
  duplicateOf?: string;
}) {
  const v = props.values;
  const field = (
    name: keyof RecipeFields,
    label: string,
    attrs: Record<string, string | number | boolean> = {}
  ) => (
    <label class="field">
      <span>{label}</span>
      <input
        name={name}
        value={v[name] != null ? String(v[name]) : ''}
        {...attrs}
      />
    </label>
  );
  return (
    <Layout
      title={`${props.mode === 'new' ? 'Add a recipe' : `Edit ${v.title ?? ''}`} — Recipe Box`}
      active={props.mode === 'new' ? 'add' : 'recipes'}
    >
      {props.mode === 'new' ? (
        <section class="card">
          <h2 class="section-title">Import from a link</h2>
          <form class="import" method="get" action={url('/new')}>
            <input
              type="url"
              name="url"
              value={props.importUrl ?? ''}
              placeholder="https://… recipe page"
              aria-label="Recipe page URL"
              required
            />
            <button class="btn" type="submit">
              Fill in
            </button>
          </form>
          <p class="muted small">
            Reads the page's recipe data so you can check it before saving.
          </p>
        </section>
      ) : null}

      <form class="card recipe-form" method="post" action={props.action}>
        {props.error ? (
          <p class="error">
            {props.error}
            {props.duplicateOf ? (
              <>
                {' '}
                <a href={recipeUrl(props.duplicateOf)}>Open it</a>
              </>
            ) : null}
          </p>
        ) : null}
        {props.notice ? <p class="notice">{props.notice}</p> : null}
        {field('title', 'Title', { required: true, maxlength: 200 })}
        <label class="field">
          <span>Description</span>
          <textarea name="description" rows={2}>
            {v.description ?? ''}
          </textarea>
        </label>
        <div class="grid">
          {field('prepMinutes', 'Prep (min)', {
            type: 'number',
            min: 0,
            inputmode: 'numeric',
          })}
          {field('cookMinutes', 'Cook (min)', {
            type: 'number',
            min: 0,
            inputmode: 'numeric',
          })}
          {field('totalMinutes', 'Total (min)', {
            type: 'number',
            min: 0,
            inputmode: 'numeric',
          })}
          {field('servings', 'Serves')}
        </div>
        <label class="field">
          <span>Ingredients — one per line</span>
          <textarea name="ingredients" rows={8}>
            {(v.ingredients ?? []).join('\n')}
          </textarea>
        </label>
        <label class="field">
          <span>Steps — one per line</span>
          <textarea name="steps" rows={8}>
            {(v.steps ?? []).join('\n')}
          </textarea>
        </label>
        {field('tags', 'Tags — comma separated', {
          value: (v.tags ?? []).join(', '),
          placeholder: 'chicken, weeknight',
        })}
        <div class="grid grid--2">
          {field('cuisine', 'Cuisine')}
          {field('course', 'Course')}
        </div>
        <label class="field">
          <span>Our notes</span>
          <textarea name="notes" rows={3}>
            {v.notes ?? ''}
          </textarea>
        </label>
        {field('sourceUrl', 'Source link', { type: 'url' })}
        {field('imageUrl', 'Image link', { type: 'url' })}
        {props.duplicateOf ? (
          <label class="check">
            <input type="checkbox" name="allowDuplicateTitle" value="1" /> Save
            anyway (it's a different recipe with the same name)
          </label>
        ) : null}
        <button class="btn btn--primary" type="submit">
          {props.mode === 'new' ? 'Save recipe' : 'Save changes'}
        </button>
      </form>
    </Layout>
  );
}

// ---- what to cook ----

export function CookPage(props: {
  members: Member[];
  eaters: string[];
  maxMinutes?: number;
  tag: string;
  tags: { tag: string; count: number }[];
  results: Recommendation[];
}) {
  const active = props.members.filter((m) => m.active);
  return (
    <Layout title="What to cook — Recipe Box" active="cook">
      <form class="card cook-form" method="get" action={url('/cook')}>
        <h2 class="section-title">Who's eating?</h2>
        {active.length ? (
          <div class="eaters">
            {active.map((m) => (
              <label class="check">
                <input
                  type="checkbox"
                  name="eaters"
                  value={m._id}
                  checked={props.eaters.includes(m._id)}
                />
                {m.name}
              </label>
            ))}
          </div>
        ) : (
          <p class="muted">
            Add your family on the <a href={url('/family')}>Family</a> page
            first.
          </p>
        )}
        <div class="grid grid--2">
          <label class="field">
            <span>Time</span>
            <select name="maxMinutes">
              {[
                ['', 'Any'],
                ['30', '30 min or less'],
                ['45', '45 min or less'],
                ['60', '1 hour or less'],
                ['90', '1½ hours or less'],
              ].map(([val, label]) => (
                <option
                  value={val}
                  selected={String(props.maxMinutes ?? '') === val}
                >
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label class="field">
            <span>Tag</span>
            <select name="tag">
              <option value="">Any</option>
              {props.tags.map((t) => (
                <option value={t.tag} selected={t.tag === props.tag}>
                  {t.tag}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button class="btn btn--primary" type="submit">
          Suggest
        </button>
      </form>
      {props.results.length ? (
        <ol class="cards recs">
          {props.results.map((r, i) => (
            <li>
              <a class="card recipe-card" href={recipeUrl(r.recipeId)}>
                <span class="recipe-card__title">
                  <span class="rank">{i + 1}</span> {r.title}
                  {r.vetoed ? <span class="chip chip--bad">vetoed</span> : null}
                </span>
                <span class="recipe-card__meta">{r.reasons.join(' · ')}</span>
              </a>
            </li>
          ))}
        </ol>
      ) : active.length ? (
        <p class="empty">Nothing fits. Loosen the time or tag.</p>
      ) : null}
    </Layout>
  );
}

// ---- family ----

export function FamilyPage(props: {
  members: Member[];
  rated: Map<string, number>;
  error?: string;
}) {
  return (
    <Layout title="Family — Recipe Box" active="family">
      <section class="card">
        <h2 class="section-title">Family members</h2>
        {props.error ? <p class="error">{props.error}</p> : null}
        {props.members.length ? (
          <ul class="members">
            {props.members.map((m) => (
              <li class={m.active ? '' : 'inactive'}>
                <form
                  class="member-row"
                  method="post"
                  action={url(`/family/${encodeURIComponent(m._id)}`)}
                >
                  <input
                    name="name"
                    value={m.name}
                    aria-label="Name"
                    maxlength={40}
                    required
                  />
                  <span class="muted small">
                    {props.rated.get(m._id) ?? 0} rated
                  </span>
                  <button class="btn btn--small" type="submit">
                    Rename
                  </button>
                  <button
                    class="btn btn--small"
                    type="submit"
                    name="active"
                    value={m.active ? 'false' : 'true'}
                  >
                    {m.active ? 'Away' : 'Back'}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <p class="muted">Nobody yet.</p>
        )}
        <form class="add-member" method="post" action={url('/family')}>
          <input
            name="name"
            placeholder="Name"
            aria-label="New member name"
            maxlength={40}
            required
          />
          <button class="btn btn--primary" type="submit">
            Add
          </button>
        </form>
        <p class="muted small">
          “Away” keeps someone's ratings but leaves them out of “who's eating”
          by default.
        </p>
      </section>
    </Layout>
  );
}
