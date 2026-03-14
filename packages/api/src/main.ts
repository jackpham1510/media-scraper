import Fastify from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import IORedis from 'ioredis';
import { parseEnv } from './config/env.js';
import { healthRoutes } from './routes/health.js';
import { scrapeRoutes } from './routes/scrape.js';
import { mediaRoutes } from './routes/media.js';
import { closeWorkers } from './worker/index.js';
import { httpAgent } from './scraper/http-client.js';
import { db } from './db/index.js';

const env = parseEnv();

const app = Fastify({
  logger: {
    level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  },
});

// Create the ioredis client for rate-limiting and job status caching
const redis = new IORedis(env.REDIS_URL);

// Decorate Fastify instance with shared resources accessible in route handlers
app.decorate('redis', redis);
app.decorate('config', env);

// Rate limiting via @fastify/rate-limit with Redis backend
await app.register(fastifyRateLimit, {
  max: env.RATE_LIMIT_MAX,
  timeWindow: env.RATE_LIMIT_WINDOW,
  redis,
});

// Register routes
await app.register(healthRoutes);
await app.register(scrapeRoutes);
await app.register(mediaRoutes);

// Graceful shutdown handler.
// NOTE: playwright.singleton.ts registers its own SIGTERM/SIGINT handlers that close
// the Playwright browser and call process.exit(0). Both handler sets fire — we do
// cleanup here (HTTP server, workers, Redis, DB) and the singleton handles the browser.
let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  app.log.info(`Received ${signal} — shutting down gracefully`);

  try {
    // Stop accepting new HTTP requests
    await app.close();

    // Close BullMQ workers (waits for in-flight jobs to finish)
    await closeWorkers();

    // Close undici HTTP agent
    await httpAgent.close();

    // Close Redis client
    redis.disconnect();

    // Disconnect Prisma
    await db.$disconnect();

    app.log.info('Graceful shutdown complete');
    // Note: process.exit(0) is called by playwright.singleton.ts shutdown handler.
    // If the browser was never launched, we call it here.
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'Error during shutdown');
    process.exit(1);
  }
}

process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });

const address = await app.listen({ port: env.PORT, host: '0.0.0.0' });
app.log.info(`Server listening at ${address}`);
