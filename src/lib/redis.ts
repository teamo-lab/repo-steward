import Redis from 'ioredis';
import { config } from '../config/index.js';
import { pino } from 'pino';

const logger = pino({ name: 'redis' });

export const redis = new Redis(config.redis.url, {
  maxRetriesPerRequest: null,  // required by BullMQ
  enableReadyCheck: false,
});

redis.on('error', (err) => {
  logger.error({ err }, 'Redis connection error');
});

redis.on('connect', () => {
  logger.info('Redis connected');
});

export async function redisHealthCheck(): Promise<boolean> {
  try {
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}
