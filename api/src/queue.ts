import { Queue } from 'bullmq';
import IORedis from 'ioredis';

if (!process.env.REDIS_URL) {
  throw new Error('REDIS_URL is required');
}

const connection = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

export const runQueue = new Queue('runs', { connection });

// Separate client for publishing cancel events to workers.
export const redisPub = new IORedis(process.env.REDIS_URL);

export const CANCEL_CHANNEL = 'run:cancel';
