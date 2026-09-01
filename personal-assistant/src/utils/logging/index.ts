export { logger, createLogger } from './logger.js';

import { createLogger } from './logger.js';

export const slackLogger = createLogger('slack');
export const schedulerLogger = createLogger('scheduler');
export const mongoLogger = createLogger('mongo');
