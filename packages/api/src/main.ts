import Fastify from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import { Redis as IORedis } from 'ioredis';
import { parseEnv } from './config/env.js';
import { healthRoutes } from './routes/health.js';
import { scrapeRoutes } from './routes/scrape.js';
import { mediaRoutes } from './routes/media.js';
import { closeWorkers } from './worker/index.js';
import { closeBrowser } from './worker/playwright.singleton.js';
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

// Add x-request-id header to every response (Fastify auto-generates request.id)
app.addHook('onSend', async (request, reply) => {
  reply.header('x-request-id', request.id as string);
});

// Log memory usage every 30s (unref so it doesn't prevent process exit)
setInterval(() => {
  const mem = process.memoryUsage();
  app.log.info({
    rss: Math.round(mem.rss / 1024 / 1024),
    heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    external: Math.round(mem.external / 1024 / 1024),
  }, 'memory usage (MB)');
}, 30_000).unref();

// Graceful shutdown handler.
// All cleanup is centralized here: HTTP server, BullMQ workers, Playwright browser,
// undici agent, Redis, and Prisma. playwright.singleton.ts does NOT register its own
// signal handlers — closeBrowser() is called explicitly in the sequence below.
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

    // Close Playwright browser (if it was ever launched)
    await closeBrowser();

    // Close undici HTTP agent
    await httpAgent.close();

    // Close Redis client
    redis.disconnect();

    // Disconnect Prisma
    await db.$disconnect();

    app.log.info('Graceful shutdown complete');
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
