import cron from 'node-cron';
import config from 'config';
import {
  sendBlockMessage,
  updateMessage,
  deleteBotMessagesBefore,
} from '../../clients/slack.js';
import { getActivePlan } from '../../clients/mongo/repositories/exercisePlan.js';
import {
  getDailyMessage,
  saveDailyMessage,
  deleteOldDailyMessages,
} from '../../clients/mongo/repositories/dailyMessage.js';
import { buildDailyPlanBlocks } from './formatter.js';
import { schedulerLogger } from '../../utils/logging/index.js';

// Outer guard so overnight ticks never hit Mongo; the real window comes from
// the plan's own blocks below.
const WINDOW_START = 6;
const WINDOW_END = 22;

cron.schedule('0 * * * *', async () => {
  const hour = new Date().getHours();
  if (hour < WINDOW_START || hour > WINDOW_END) return;

  const userId = config.get<string>('targetUserId');
  if (!userId) {
    schedulerLogger.warn('No targetUserId configured, skipping reminder');
    return;
  }

  const plan = await getActivePlan(userId);
  if (!plan || plan.blocks.length === 0) {
    schedulerLogger.debug('No active exercise plan', { hour });
    return;
  }

  const planHours = plan.blocks.map((b) => b.hour);
  const firstHour = Math.min(...planHours);
  // One tick past the last block so it gets its completed checkmark.
  const lastHour = Math.max(...planHours) + 1;
  if (hour < firstHour || hour > lastHour) return;

  const todayStr = new Date().toISOString().slice(0, 10);
  const existing = await getDailyMessage(userId, todayStr);
  const blocks = buildDailyPlanBlocks(plan.blocks, hour, plan.slackNotes);
  const fallbackText = `Exercise Plan — ${todayStr}`;

  if (existing) {
    try {
      await updateMessage(
        existing.channelId,
        existing.messageTs,
        fallbackText,
        blocks
      );
      schedulerLogger.info('Updated daily exercise message', { hour });
    } catch (error) {
      schedulerLogger.warn('Failed to update message, sending new one', {
        error: (error as Error).message,
      });
      const result = await sendBlockMessage(userId, fallbackText, blocks);
      if (result) {
        await saveDailyMessage(
          userId,
          todayStr,
          result.channelId,
          result.messageTs
        );
      }
    }
  } else {
    const result = await sendBlockMessage(userId, fallbackText, blocks);
    if (result) {
      await saveDailyMessage(
        userId,
        todayStr,
        result.channelId,
        result.messageTs
      );
      schedulerLogger.info('Sent new daily exercise message', { hour });

      // Delete all bot messages older than yesterday from the DM channel
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayTs = (yesterday.getTime() / 1000).toString();
      const deleted = await deleteBotMessagesBefore(
        result.channelId,
        yesterdayTs,
        result.messageTs
      );
      if (deleted > 0) {
        schedulerLogger.info('Cleaned up old messages from Slack', {
          count: deleted,
        });
      }

      // Clean up old DB records too
      const yesterdayStr = yesterday.toISOString().slice(0, 10);
      await deleteOldDailyMessages(userId, yesterdayStr);
    }
  }
});

schedulerLogger.info('Exercise scheduler initialized');
