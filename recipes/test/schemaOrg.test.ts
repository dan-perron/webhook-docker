import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  clean,
  durationMinutes,
  NoRecipeFound,
  recipeFromHtml,
} from '../src/import/schemaOrg.js';

// Fixtures are real pages trimmed to their Recipe ld+json blocks.
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');

describe('durationMinutes', () => {
  it.each([
    ['PT30M', 30],
    ['PT1H30M', 90],
    ['P0DT0H45M', 45],
    ['PT2H', 120],
    ['P1DT2H', 1560],
    ['PT90S', 2],
    ['pt20m', 20],
    ['PT0M', undefined],
    ['P', undefined],
    ['30 minutes', undefined],
  ])('%s -> %s', (iso, minutes) => {
    expect(durationMinutes(iso)).toBe(minutes);
  });
});

describe('clean', () => {
  it('decodes (double-)encoded entities and strips tags', () => {
    expect(clean('Saut&eacute;? no: Saut&#233; &amp;amp; <b>stir</b>')).toBe(
      'Saut&eacute;? no: Sauté & stir'
    );
    expect(clean('8 1/2&quot; x 4&#x27;  pan')).toBe('8 1/2" x 4\' pan');
  });
});

describe('real pages', () => {
  it('Budget Bytes (WPRM @graph): times, cost annotations stripped', () => {
    const r = recipeFromHtml(fixture('budgetbytes'));
    expect(r).toMatchObject({
      title: 'One Pot Creamy Cajun Chicken Pasta',
      servings: '4',
      prepMinutes: 10,
      cookMinutes: 20,
      totalMinutes: 30,
      cuisine: 'American',
      course: 'Dinner',
    });
    expect(r.ingredients).toHaveLength(17);
    expect(r.ingredients[0]).toBe('2 tsp smoked paprika');
    expect(r.ingredients.join(' ')).not.toContain('$');
    expect(r.steps).toHaveLength(6);
    expect(r.tags).toEqual(expect.arrayContaining(['one pot', 'quick']));
  });

  it('NYT Cooking: category list -> course + tags', () => {
    const r = recipeFromHtml(fixture('nyt'));
    expect(r).toMatchObject({
      title: 'Mississippi Roast',
      servings: '6 to 8 servings',
      totalMinutes: 480,
      course: 'Dinner',
    });
    expect(r.tags).toEqual(
      expect.arrayContaining(['kid-friendly', 'slow cooker', 'chuck roast'])
    );
    expect(r.steps).toHaveLength(3);
  });

  it('Love & Lemons: SEO keywords repeating the title are dropped', () => {
    const r = recipeFromHtml(fixture('loveandlemons'));
    expect(r.title).toBe('Vegetable Soup');
    expect(r.tags).toEqual([]);
    expect(r.ingredients).toHaveLength(18);
    expect(r.course).toBe('Soup');
  });

  it('BBC Good Food: keeps single-word keywords, drops the author', () => {
    const r = recipeFromHtml(fixture('bbcgoodfood'));
    expect(r.title).toBe('Easy chicken curry');
    expect(r.tags).toEqual(expect.arrayContaining(['chicken', 'curry']));
    expect(r.tags).not.toContain('esther clark');
    expect(r.sourceUrl).toBe(
      'https://www.bbcgoodfood.com/recipes/easy-chicken-curry'
    );
    expect(r.totalMinutes).toBe(50);
  });

  it('King Arthur: ";"-separated keywords, total time differs from prep+cook', () => {
    const r = recipeFromHtml(fixture('kingarthur'));
    expect(r).toMatchObject({
      title: 'Classic Sandwich Bread',
      servings: '1 loaf',
      prepMinutes: 12,
      cookMinutes: 40,
      totalMinutes: 162,
    });
    expect(r.tags).toEqual(['sandwich bread', 'tangzhong']);
  });

  it('prefers the page URL it was fetched from', () => {
    const r = recipeFromHtml(
      fixture('kingarthur'),
      'https://www.kingarthurbaking.com/recipes/classic-sandwich-bread-recipe'
    );
    expect(r.sourceUrl).toBe(
      'https://www.kingarthurbaking.com/recipes/classic-sandwich-bread-recipe'
    );
  });
});

describe('structures', () => {
  const page = (ld: unknown) =>
    `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head></html>`;

  it('HowToSection headings become steps ending in ":"', () => {
    const r = recipeFromHtml(
      page({
        '@context': 'https://schema.org',
        '@type': ['Recipe', 'NewsArticle'],
        name: 'Layered',
        recipeYield: ['8', '8 servings'],
        image: [{ '@type': 'ImageObject', url: '/img/a.jpg' }],
        recipeInstructions: [
          {
            '@type': 'HowToSection',
            name: 'For the sauce',
            itemListElement: [
              { '@type': 'HowToStep', text: 'Simmer.' },
              { '@type': 'HowToStep', text: 'Season.' },
            ],
          },
          { '@type': 'HowToStep', text: 'Serve &amp; enjoy.' },
        ],
      }),
      'https://example.com/r/layered'
    );
    expect(r.steps).toEqual([
      'For the sauce:',
      'Simmer.',
      'Season.',
      'Serve & enjoy.',
    ]);
    expect(r.servings).toBe('8 servings');
    expect(r.imageUrl).toBe('https://example.com/img/a.jpg');
  });

  it('finds the Recipe as mainEntity, and splits text instructions', () => {
    const r = recipeFromHtml(
      page({
        '@type': 'WebPage',
        mainEntity: {
          '@type': 'Recipe',
          name: 'Toast',
          recipeIngredient: ['1 slice bread'],
          recipeInstructions: 'Toast it.\nButter it.',
        },
      })
    );
    expect(r.steps).toEqual(['Toast it.', 'Butter it.']);
  });

  it('skips ld+json blocks that are not recipes or not valid JSON', () => {
    const html =
      '<script type="application/ld+json">{not json</script>' +
      '<script type="application/ld+json">{"@type":"Organization","name":"x"}</script>' +
      '<script type=application/ld+json>{"@type":"Recipe","name":"Found"}</script>';
    expect(recipeFromHtml(html).title).toBe('Found');
  });

  it('throws NoRecipeFound on a page without recipe data', () => {
    expect(() => recipeFromHtml('<html><body>hi</body></html>')).toThrow(
      NoRecipeFound
    );
  });
});
