import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: undefined, // pid/hostname 생략
});

export type Logger = typeof logger;
