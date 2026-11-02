import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Child } from 'hono/jsx';
import { url } from '../util/url.js';

// Change asset URLs whenever their contents change, so browsers can't reuse
// an older stylesheet after a deployment.
const versions = Object.fromEntries(
  ['styles.css', 'htmx.min.js'].map((name) => [
    name,
    createHash('sha256')
      .update(readFileSync(new URL(`../../public/${name}`, import.meta.url)))
      .digest('hex')
      .slice(0, 12),
  ])
);
const asset = (name: 'styles.css' | 'htmx.min.js') =>
  `${url(`/static/${name}`)}?v=${versions[name]}`;

export type Tab = 'recipes' | 'cook' | 'add' | 'family';

export function Layout(props: {
  title: string;
  active?: Tab;
  children: Child;
}) {
  const tab = (key: Tab, href: string, label: string, icon: string) => (
    <a
      href={href}
      class={`tab ${props.active === key ? 'tab--active' : ''}`}
      aria-current={props.active === key ? 'page' : undefined}
    >
      <span class="tab__icon" aria-hidden="true">
        {icon}
      </span>
      <span class="tab__label">{label}</span>
    </a>
  );
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />
        <meta name="theme-color" content="#b4532a" />
        <title>{props.title}</title>
        <link rel="stylesheet" href={asset('styles.css')} />
        <script src={asset('htmx.min.js')} defer></script>
      </head>
      <body>
        <header class="appbar">
          <a class="appbar__title" href={url('/')}>
            Recipe Box
          </a>
        </header>
        <main class="content">{props.children}</main>
        {props.active ? (
          <nav class="tabbar">
            {tab('recipes', url('/'), 'Recipes', '📖')}
            {tab('cook', url('/cook'), 'What to cook', '🍳')}
            {tab('add', url('/new'), 'Add', '➕')}
            {tab('family', url('/family'), 'Family', '👪')}
          </nav>
        ) : null}
      </body>
    </html>
  );
}

export function Stars(props: { value: number | null; label?: string }) {
  const v = props.value;
  if (v == null) return <span class="stars stars--none">unrated</span>;
  const full = Math.round(v);
  return (
    <span class="stars" aria-label={props.label ?? `${v} out of 5 stars`}>
      {'★'.repeat(full)}
      <span class="stars__off">{'★'.repeat(5 - full)}</span>
    </span>
  );
}

export function LoginPage(props: { error?: string }) {
  return (
    <Layout title="Sign in — Recipe Box">
      <section class="card login">
        <h1>Recipe Box</h1>
        <p class="muted">Enter your password.</p>
        {props.error ? <p class="error">{props.error}</p> : null}
        <form method="post" action={url('/login')}>
          <input
            name="password"
            type="password"
            autocomplete="current-password"
            aria-label="Password"
            placeholder="Password"
            required
            autofocus
          />
          <button class="btn btn--primary" type="submit">
            Sign in
          </button>
        </form>
      </section>
    </Layout>
  );
}

export const minutesLabel = (m: number | undefined) =>
  m == null
    ? ''
    : m < 60
      ? `${m} min`
      : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
