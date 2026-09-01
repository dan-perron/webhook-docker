import type { Child } from 'hono/jsx';
import { asset, url } from '../util/url.js';

interface LayoutProps {
  title: string;
  /** Only the event page needs the paint interaction. */
  withGrid?: boolean;
  /** Only the create form needs the date-field helper. */
  withDates?: boolean;
  children: Child;
}

/** Full page shell: head, app bar, content slot. */
export function Layout({ title, withGrid, withDates, children }: LayoutProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />
        <meta name="theme-color" content="#1d6fb8" />
        <title>{title}</title>
        <link rel="stylesheet" href={asset('/static/styles.css')} />
        <script src={url('/static/htmx.min.js')} defer></script>
        {withGrid ? (
          <script src={asset('/static/grid.js')} defer></script>
        ) : null}
        {withDates ? (
          <script src={asset('/static/datefield.js')} defer></script>
        ) : null}
      </head>
      <body>
        <header class="appbar">
          <a class="appbar__title" href={url('/')}>
            🗓 When Can We Meet
          </a>
        </header>
        <main class="content">{children}</main>
      </body>
    </html>
  );
}

/**
 * Inline JSON for grid.js. `<` is escaped so a `</script>` inside a participant
 * name can't break out of the tag.
 */
export function JsonScript({ id, value }: { id: string; value: unknown }) {
  const json = JSON.stringify(value).replace(/</g, '\\u003c');
  return (
    <script
      type="application/json"
      id={id}
      dangerouslySetInnerHTML={{ __html: json }}
    />
  );
}
