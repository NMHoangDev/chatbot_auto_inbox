import winston from 'winston';

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'HH:mm:ss.SSS DD/MM/YYYY' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const extras = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
      return `${timestamp} [${level.toUpperCase()}] ${message}${extras}`;
    })
  ),
  transports: [new winston.transports.Console()],
});
