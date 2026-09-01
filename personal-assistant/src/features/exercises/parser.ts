import type { ExerciseBlock, ParsedPlan } from './types.js';
import { formatSlackMrkdwn } from './formatter.js';

// Named time-of-day blocks map to these hours unless the header carries an
// explicit time, e.g. "## Morning Warm-Up (7:00 AM)".
// "afternoon" is tested before "noon" so it can't be swallowed by it.
const NAMED_HOURS: Array<[RegExp, number]> = [
  [/\bmorning\b/, 7],
  [/\bafternoon\b/, 15],
  [/\b(?:noon|midday|mid-day|lunch)\b/, 12],
  [/\b(?:night|evening|bedtime)\b/, 20],
];

// A "## ..." section matching this holds plan-wide notes rather than exercises.
const NOTES_HEADER = /\b(?:modification|restriction|note)/;

const TIME_PATTERN = /(\d{1,2}):(\d{2})\s*(AM|PM)/i;

function parseHourTo24(timeStr: string): number {
  const match = timeStr.match(TIME_PATTERN);
  if (!match) return -1;
  let hour = parseInt(match[1], 10);
  const period = match[3].toUpperCase();
  if (period === 'PM' && hour !== 12) hour += 12;
  if (period === 'AM' && hour === 12) hour = 0;
  return hour;
}

// Drop the time from the header and any separator left dangling by its removal,
// keeping emoji and internal dashes: "🌤️ Afternoon — PT Strength Block".
function cleanTitle(header: string): string {
  return header
    .replace(/[([]\s*\d{1,2}:\d{2}\s*(?:AM|PM)\s*[)\]]/i, '')
    .replace(TIME_PATTERN, '')
    .replace(/^[\s—–\-·|]+/, '')
    .replace(/[\s—–\-·|]+$/, '')
    .trim();
}

function cleanBody(lines: string[]): string {
  return lines
    .filter((line) => !/^\s*(?:-{3,}|_{3,}|\*{3,})\s*$/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

type Section =
  | { kind: 'block'; hour: number; title: string }
  | { kind: 'notes' }
  | null;

function classifyHeader(header: string): Section {
  const text = header.trim();
  if (!text) return null;

  const lower = text.toLowerCase();
  if (NOTES_HEADER.test(lower)) return { kind: 'notes' };

  const explicit = text.match(TIME_PATTERN);
  if (explicit) {
    const hour = parseHourTo24(explicit[0]);
    if (hour < 0) return null;
    return { kind: 'block', hour, title: cleanTitle(text) || 'Exercises' };
  }

  for (const [pattern, hour] of NAMED_HOURS) {
    if (pattern.test(lower)) {
      return { kind: 'block', hour, title: cleanTitle(text) };
    }
  }

  return null;
}

export function parseExercisePlan(markdown: string): ParsedPlan {
  const blocks: ExerciseBlock[] = [];
  let notes: string | undefined;

  let current: Section = null;
  let bodyLines: string[] = [];

  function flush() {
    if (!current) return;
    const body = cleanBody(bodyLines);
    if (current.kind === 'notes') {
      if (body) notes = body;
    } else {
      blocks.push({
        hour: current.hour,
        title: current.title,
        markdownBody: body,
        slackBody: formatSlackMrkdwn(body),
      });
    }
  }

  for (const line of markdown.split('\n')) {
    const headerMatch = line.match(/^##\s+(.+)$/);
    if (headerMatch) {
      flush();
      current = classifyHeader(headerMatch[1]);
      bodyLines = [];
    } else if (current) {
      bodyLines.push(line);
    }
  }
  flush();

  blocks.sort((a, b) => a.hour - b.hour);

  return {
    blocks,
    notes,
    slackNotes: notes ? formatSlackMrkdwn(notes) : undefined,
  };
}
