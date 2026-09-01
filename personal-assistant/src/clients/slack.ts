import bolt from '@slack/bolt';
import type { KnownBlock } from '@slack/types';
import config from 'config';
import { slackLogger } from '../utils/logging/index.js';
const App = bolt.App;
const { LogLevel } = bolt;

const boltLogger = {
  debug: (...msgs: string[]) =>
    slackLogger.debug(`[Bolt SDK] ${msgs.join(' ')}`),
  info: (...msgs: string[]) => slackLogger.info(`[Bolt SDK] ${msgs.join(' ')}`),
  warn: (...msgs: string[]) => slackLogger.warn(`[Bolt SDK] ${msgs.join(' ')}`),
  error: (...msgs: string[]) =>
    slackLogger.error(`[Bolt SDK] ${msgs.join(' ')}`),
  setLevel: () => {},
  getLevel: () => LogLevel.INFO,
  setName: () => {},
};

export const app = new App({
  token: config.get('slack.token'),
  signingSecret: config.get('slack.signingSecret'),
  socketMode: true,
  appToken: config.get('slack.appToken'),
  logger: boltLogger,
  logLevel: LogLevel.INFO,
});

app.error(async (error) => {
  slackLogger.error('Slack app error', {
    error: error.message,
    stack: error.stack,
  });
});

(async () => {
  try {
    await app.start();
    slackLogger.info('Bolt app is running');
  } catch (error) {
    slackLogger.error('Error starting Slack app', { error: error.message });
    process.exit(1);
  }
})();

export async function sendDirectMessage(
  userId: string,
  text: string
): Promise<{ channelId: string; messageTs: string } | null> {
  try {
    const conv = await app.client.conversations.open({ users: userId });
    const channelId = conv.channel!.id!;
    const msg = await app.client.chat.postMessage({
      channel: channelId,
      text,
    });
    return { channelId, messageTs: msg.ts! };
  } catch (error) {
    slackLogger.error('Error sending direct message', {
      userId,
      error: error.message,
    });
    return null;
  }
}

export async function sendBlockMessage(
  userId: string,
  text: string,
  blocks: KnownBlock[]
): Promise<{ channelId: string; messageTs: string } | null> {
  try {
    const conv = await app.client.conversations.open({ users: userId });
    const channelId = conv.channel!.id!;
    const msg = await app.client.chat.postMessage({
      channel: channelId,
      text,
      blocks,
    });
    return { channelId, messageTs: msg.ts! };
  } catch (error) {
    slackLogger.error('Error sending block message', {
      userId,
      error: error.message,
    });
    return null;
  }
}

export async function deleteMessage(
  channelId: string,
  messageTs: string
): Promise<void> {
  await app.client.chat.delete({
    channel: channelId,
    ts: messageTs,
  });
}

export async function deleteBotMessagesBefore(
  channelId: string,
  beforeTs: string,
  keepTs?: string
): Promise<number> {
  let deleted = 0;
  let cursor: string | undefined;

  do {
    const result = await app.client.conversations.history({
      channel: channelId,
      latest: beforeTs,
      limit: 100,
      cursor,
    });

    for (const msg of result.messages ?? []) {
      if (msg.bot_id && msg.ts !== keepTs) {
        try {
          await app.client.chat.delete({ channel: channelId, ts: msg.ts! });
          deleted++;
        } catch {
          // message already deleted or not deletable
        }
      }
    }

    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return deleted;
}

export async function updateMessage(
  channelId: string,
  messageTs: string,
  text: string,
  blocks: KnownBlock[]
): Promise<void> {
  await app.client.chat.update({
    channel: channelId,
    ts: messageTs,
    text,
    blocks,
  });
}
