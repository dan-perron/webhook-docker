/** Lowercase, accents stripped, alphanumerics only: for matching names. */
export const normalizeName = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** URL-safe id from a name: "Spanish squat (iso)" -> "spanish-squat-iso". */
export const slugify = (s: string) =>
  normalizeName(s).replace(/ /g, '-').slice(0, 60) || 'item';
