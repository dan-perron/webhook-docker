import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { url } from '../util/url.js';

// Change asset URLs whenever their contents change, so browsers can't reuse
// an older card layout or client script after a deployment.
const versions = Object.fromEntries(
  ['styles.css', 'app.js'].map((name) => [
    name,
    createHash('sha256')
      .update(readFileSync(new URL(`../../public/${name}`, import.meta.url)))
      .digest('hex')
      .slice(0, 12),
  ])
);
export const assetUrl = (name: 'styles.css' | 'app.js') =>
  `${url(`/static/${name}`)}?v=${versions[name]}`;
