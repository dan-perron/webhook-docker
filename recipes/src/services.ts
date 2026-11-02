import type { Db } from 'mongodb';
import { RecipeStore } from './db/store.js';
import type { RecommendParams } from './domain/recommend.js';
import { fetchPage } from './import/fetchPage.js';
import { recipeFromHtml } from './import/schemaOrg.js';
import type { RecipeFields } from './domain/types.js';
import { localDate } from './util/date.js';

export interface Services {
  store: RecipeStore;
  /** Fetch a page and map its schema.org Recipe (never saves). */
  importUrl: (url: string) => Promise<RecipeFields>;
  recommend: RecommendParams;
  /** Absolute app URL for links in MCP results, e.g. https://djperron.com/recipes */
  appUrl: string;
  /** Today's local date, YYYY-MM-DD. */
  today: () => string;
}

export function createServices(
  db: Db,
  opts: {
    recommend: RecommendParams;
    appUrl: string;
    timeZone: string;
    now?: () => Date;
    fetch?: typeof fetch;
    resolve?: (host: string) => Promise<string[]>;
  }
): Services {
  const now = opts.now ?? (() => new Date());
  return {
    store: new RecipeStore(db, now),
    importUrl: async (url) => {
      const page = await fetchPage(url, {
        fetch: opts.fetch,
        resolve: opts.resolve,
      });
      return recipeFromHtml(page.html, page.url);
    },
    recommend: opts.recommend,
    appUrl: opts.appUrl,
    today: () => localDate(now(), opts.timeZone),
  };
}
