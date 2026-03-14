import { Queue, Worker } from 'bullmq';
import { parseEnv } from '../config/env.js';
import { fastProcessor } from './fast.processor.js';
import { browserProcessor } from './browser.processor.js';

const env = parseEnv();

// Parse REDIS_URL (e.g., redis://host:port) into host/port for BullMQ
const redisUrl = new URL(env.REDIS_URL);
const connection = {
  host: redisUrl.hostname,
  port: parseInt(redisUrl.port || '6379', 10),
};

// Two queues — exported so routes can check depth and enqueue jobs
export const fastQueue = new Queue('scrape:fast', { connection });
export const browserQueue = new Queue('scrape:browser', { connection });

// FastScrapeWorker: concurrency 2 (two BullMQ jobs in parallel)
// CRITICAL: p-limit(70) global singleton in http-client.ts limits actual HTTP concurrency
const fastWorker = new Worker('scrape:fast', fastProcessor, { connection, concurrency: 2 });

// BrowserScrapeWorker: concurrency 1 — hard cap, 1 GB RAM budget has no room for 2 Chromium tabs
const browserWorker = new Worker('scrape:browser', browserProcessor, { connection, concurrency: 1 });

// Error handlers to prevent unhandled promise rejections from killing the process
fastWorker.on('error', (err) => {
  console.error('FastWorker error:', err);
});

browserWorker.on('error', (err) => {
  console.error('BrowserWorker error:', err);
});

/**
 * Graceful shutdown: pause workers and wait for in-flight jobs to finish,
 * then close queue connections.
 */
export async function closeWorkers(): Promise<void> {
  await Promise.allSettled([
    fastWorker.close(),
    browserWorker.close(),
    fastQueue.close(),
    browserQueue.close(),
  ]);
}
