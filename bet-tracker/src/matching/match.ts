import type { Side } from '../domain/types.js';
import type { ProviderEvent } from '../gamestate/types.js';

// Fuzzy team/fighter matching of a leg's two participants to provider events.
// Never guesses: anything short of exactly one confident event is returned as
// candidates for confirmation.

export const CONFIDENT = 0.85;
const CANDIDATE_FLOOR = 0.5;
const MAX_CANDIDATES = 5;

const STOPWORDS = new Set(['the', 'fc', 'cf', 'sc', 'university', 'of']);

/**
 * College names written out where ESPN uses the short form (after "St" is
 * expanded): the leading words are replaced on both sides of a comparison.
 */
const CANONICAL: ReadonlyArray<readonly [string, string]> = [
  ['ut san antonio', 'utsa'],
  ['texas san antonio', 'utsa'],
  ['alabama birmingham', 'uab'],
  ['alabama at birmingham', 'uab'],
  ['texas el paso', 'utep'],
  ['nevada las vegas', 'unlv'],
  ['central florida', 'ucf'],
  ['virginia commonwealth', 'vcu'],
  ['southern methodist', 'smu'],
  ['brigham young', 'byu'],
  ['texas christian', 'tcu'],
  ['louisiana state', 'lsu'],
  ['southern california', 'usc'],
  ['florida international', 'fiu'],
  ['florida atlantic', 'fau'],
  ['miami florida', 'miami'],
  ['miami fl', 'miami'],
  ['miami ohio', 'miami oh'],
];

/**
 * Lowercase, strip accents/punctuation and filler words. "St" leading a
 * name is Saint, anywhere else State ("San José St" = "San Jose State");
 * known long college names become ESPN's short form ("UT San Antonio" =
 * "UTSA", "Miami (FL)" = "Miami").
 */
export function normalizeName(s: string): string {
  const words = s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOPWORDS.has(t))
    .map((t, i) => (t === 'st' ? (i === 0 ? 'saint' : 'state') : t));
  let out = words.join(' ');
  for (const [long, short] of CANONICAL) {
    if (out === long || out.startsWith(`${long} `)) {
      out = short + out.slice(long.length);
      break;
    }
  }
  return out;
}

/**
 * Words that make a different school when they follow a name: "Georgia" is
 * not "Georgia State", "Miami" is not "Miami (OH)".
 */
const QUALIFIERS = new Set([
  'state',
  'tech',
  'southern',
  'northern',
  'eastern',
  'western',
  'central',
  'christian',
  'international',
  'baptist',
  'atlantic',
  'poly',
  'and', // A&M
  'oh',
  'fl',
  'upstate',
]);

function bigrams(s: string): string[] {
  const t = s.replace(/ /g, '');
  const out: string[] = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return out;
}

/** Sørensen–Dice similarity on character bigrams (0..1). */
export function dice(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  if (x.length === 0 || y.length === 0) return a === b ? 1 : 0;
  const counts = new Map<string, number>();
  for (const g of y) counts.set(g, (counts.get(g) ?? 0) + 1);
  let hits = 0;
  for (const g of x) {
    const n = counts.get(g) ?? 0;
    if (n > 0) {
      hits++;
      counts.set(g, n - 1);
    }
  }
  return (2 * hits) / (x.length + y.length);
}

/**
 * How well an entered name matches one side's aliases (0..1).
 * 1.0 exact alias; 0.9 the entered words lead an alias ("Minnesota" vs
 * "Minnesota Golden Gophers"); 0.88 a near-identical spelling; 0.8 when the
 * next word makes it another school (only a candidate: "Georgia" vs "Georgia
 * State Panthers", "Miami" vs "Miami (OH) RedHawks"); else scaled bigram
 * similarity.
 */
export function nameScore(entered: string, aliases: string[]): number {
  const e = normalizeName(entered);
  if (!e) return 0;
  const norm = aliases.map(normalizeName).filter(Boolean);
  if (norm.includes(e)) return 1;
  const ew = e.split(' ');
  let best = 0;
  for (const a of norm) {
    const words = a.split(' ');
    if (words.length > ew.length && ew.every((w, i) => words[i] === w)) {
      best = Math.max(best, QUALIFIERS.has(words[ew.length]!) ? 0.8 : 0.9);
    }
    // Near-identical spellings ("Mississipi") are confident; the rest scale
    // below the confidence bar so they only ever become candidates.
    const d = dice(e, a);
    best = Math.max(best, d >= 0.9 ? 0.88 : d * 0.85);
  }
  return best;
}

/**
 * Aliases for a bare full team name (The Odds API gives only those): the
 * name, its nickname (last one or two words: "Rams", "White Sox") and its
 * place ("Los Angeles"). Ambiguous aliases are fine for filtering.
 */
export function teamAliases(fullName: string): string[] {
  const words = fullName.trim().split(/\s+/);
  if (words.length < 2) return [fullName];
  return [
    fullName,
    words.slice(-1).join(' '),
    words.slice(-2).join(' '),
    words.slice(0, -1).join(' '),
  ];
}

export interface Candidate {
  event: ProviderEvent;
  score: number;
  /** Which side of the event each entered participant matched. */
  sides: [Side, Side];
}

export type MatchResult =
  | { status: 'matched'; candidate: Candidate }
  | { status: 'needs_confirmation'; candidates: Candidate[] }
  | { status: 'unmatched'; candidates: [] };

/** Score an event: the weaker participant match under the best assignment. */
export function scoreEvent(
  participants: [string, string],
  event: ProviderEvent
): Candidate {
  const [p, q] = participants;
  const hp = nameScore(p, event.home.aliases);
  const ap = nameScore(p, event.away.aliases);
  const hq = nameScore(q, event.home.aliases);
  const aq = nameScore(q, event.away.aliases);
  const straight = Math.min(hp, aq);
  const swapped = Math.min(ap, hq);
  return straight >= swapped
    ? { event, score: straight, sides: ['home', 'away'] }
    : { event, score: swapped, sides: ['away', 'home'] };
}

export function matchEvent(
  participants: [string, string],
  events: ProviderEvent[]
): MatchResult {
  const scored = events
    .map((e) => scoreEvent(participants, e))
    .filter((c) => c.score >= CANDIDATE_FLOOR)
    .sort((a, b) => b.score - a.score);
  const confident = scored.filter((c) => c.score >= CONFIDENT);
  if (confident.length === 1) {
    return { status: 'matched', candidate: confident[0]! };
  }
  if (scored.length === 0) return { status: 'unmatched', candidates: [] };
  return {
    status: 'needs_confirmation',
    candidates: scored.slice(0, MAX_CANDIDATES),
  };
}
