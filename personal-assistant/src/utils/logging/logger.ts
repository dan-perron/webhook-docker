import winston from 'winston';

const isDevelopment = process.env.NODE_ENV !== 'production';

const logFormat = winston.format.printf(
  ({ level, message, timestamp, module, ...metadata }) => {
    let msg = `${timestamp} [${level}]`;
    if (module) {
      msg += ` [${module}]`;
    }
    msg += `: ${message}`;

    const metadataKeys = Object.keys(metadata);
    if (metadataKeys.length > 0) {
      msg += ` ${JSON.stringify(metadata)}`;
    }

    return msg;
  }
);

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info'),
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.colorize(),
    logFormat
  ),
  transports: [new winston.transports.Console()],
});

export function createLogger(module: string) {
  return logger.child({ module });
}
