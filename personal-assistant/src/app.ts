import 'source-map-support/register.js';
import './clients/slack.js';
import './features/exercises/slashCommand.js';
import './features/exercises/scheduler.js';
import { logger } from './utils/logging/index.js';

process.on('unhandledRejection', (error: Error) => {
  logger.error('Unhandled rejection', {
    error: error.message,
    stack: error.stack,
  });
});
