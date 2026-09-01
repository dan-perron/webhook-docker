import { app, sendDirectMessage } from '../../clients/slack.js';
import { parseExercisePlan } from './parser.js';
import { formatHour } from './formatter.js';
import { savePlan } from '../../clients/mongo/repositories/exercisePlan.js';
import { slackLogger } from '../../utils/logging/index.js';

const MODAL_CALLBACK_ID = 'exercises_upload_modal';
const INPUT_BLOCK_ID = 'markdown_input_block';
const INPUT_ACTION_ID = 'markdown_input';

function buildUploadModal() {
  return {
    type: 'modal' as const,
    callback_id: MODAL_CALLBACK_ID,
    title: { type: 'plain_text' as const, text: 'Upload Exercise Plan' },
    submit: { type: 'plain_text' as const, text: 'Upload' },
    blocks: [
      {
        type: 'input' as const,
        block_id: INPUT_BLOCK_ID,
        label: {
          type: 'plain_text' as const,
          text: 'Paste your exercise plan markdown',
        },
        element: {
          type: 'plain_text_input' as const,
          action_id: INPUT_ACTION_ID,
          multiline: true,
          placeholder: {
            type: 'plain_text' as const,
            text: '## ☀️ Morning Warm-Up\n\nExercise description...\n\n## 🕛 Noon\n\n...',
          },
        },
      },
    ],
  };
}

app.command('/assistant', async ({ command, ack, client }) => {
  await ack();

  const subcommand = command.text.trim().toLowerCase();

  if (
    !subcommand ||
    subcommand === 'exercises upload' ||
    subcommand === 'exercises edit'
  ) {
    await client.views.open({
      trigger_id: command.trigger_id,
      view: buildUploadModal(),
    });
  } else {
    await sendDirectMessage(
      command.user_id,
      'Available commands:\n- `/assistant` — Upload a new exercise plan'
    );
  }
});

app.view(MODAL_CALLBACK_ID, async ({ ack, view, body }) => {
  const markdown =
    view.state.values[INPUT_BLOCK_ID][INPUT_ACTION_ID].value ?? '';
  const userId = body.user.id;

  const plan = parseExercisePlan(markdown);

  if (plan.blocks.length === 0) {
    await ack({
      response_action: 'errors',
      errors: {
        [INPUT_BLOCK_ID]:
          'Could not parse any exercise blocks. Each section needs a ## header naming a time of day (Morning, Noon, Afternoon, Night) or an explicit time (## 9:00 AM — Title).',
      },
    });
    return;
  }

  await ack();

  try {
    await savePlan(userId, plan, markdown);
    const summary = plan.blocks
      .map((b) => `${formatHour(b.hour)} ${b.title}`)
      .join(', ');
    const notesNote = plan.notes
      ? ' Active modifications will be pinned to the top of each daily message.'
      : '';
    await sendDirectMessage(
      userId,
      `Exercise plan uploaded with ${plan.blocks.length} blocks (${summary}). Previous plan deactivated.${notesNote}`
    );
    slackLogger.info('Exercise plan uploaded', {
      userId,
      blockCount: plan.blocks.length,
      hasNotes: Boolean(plan.notes),
    });
  } catch (error) {
    slackLogger.error('Error saving exercise plan', {
      error: (error as Error).message,
    });
    await sendDirectMessage(
      userId,
      'Error saving your exercise plan. Please try again.'
    );
  }
});

slackLogger.info('Exercise slash command registered');
