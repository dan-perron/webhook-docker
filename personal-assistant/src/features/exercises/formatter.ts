import type { KnownBlock } from '@slack/types';
import type { ExerciseBlock } from './types.js';

// Slack rejects a section whose text exceeds 3000 characters.
const SECTION_TEXT_LIMIT = 3000;

export function formatSlackMrkdwn(markdown: string): string {
  return (
    markdown
      // Convert ### sub-headers to bold lines
      .replace(/^###\s+(.+)$/gm, '*$1*')
      // Convert **bold** to *bold* (Slack format)
      .replace(/\*\*(.+?)\*\*/g, '*$1*')
      // Strip any remaining # header markers
      .replace(/^#+\s+/gm, '')
  );
  // _italic_, `code`, - bullets, and emoji all work as-is in Slack
}

export function formatHour(hour: number): string {
  const period = hour >= 12 ? 'PM' : 'AM';
  const h = hour % 12 || 12;
  return `${h}:00 ${period}`;
}

function truncate(text: string): string {
  if (text.length <= SECTION_TEXT_LIMIT) return text;
  return `${text.slice(0, SECTION_TEXT_LIMIT - 2)}…`;
}

export function buildDailyPlanBlocks(
  blocks: ExerciseBlock[],
  currentHour: number,
  slackNotes?: string
): KnownBlock[] {
  const sorted = [...blocks].sort((a, b) => a.hour - b.hour);
  const slackBlocks: KnownBlock[] = [];

  if (slackNotes) {
    slackBlocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: truncate(
          `:warning: *Current Active Modifications*\n\n${slackNotes}`
        ),
      },
    });
  }

  for (let i = 0; i < sorted.length; i++) {
    const block = sorted[i];
    const isPast = block.hour < currentHour;
    const isCurrent = block.hour === currentHour;

    if (i > 0 || slackNotes) {
      slackBlocks.push({ type: 'divider' });
    }

    let prefix = '';
    if (isPast) prefix = ':white_check_mark: ';
    else if (isCurrent) prefix = ':arrow_right: ';

    const body = block.slackBody ? `\n\n${block.slackBody}` : '';

    slackBlocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: truncate(
          `${prefix}*${formatHour(block.hour)} — ${block.title}*${body}`
        ),
      },
    });
  }

  return slackBlocks;
}
