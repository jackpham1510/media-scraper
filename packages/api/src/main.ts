import Fastify from 'fastify';
import { Redis as IORedis } from 'ioredis';
import { parseEnv } from './config/env.js';
import { healthRoutes } from './routes/health.js';
import { scrapeRoutes } from './routes/scrape.js';
import { mediaRoutes } from './routes/media.js';
import { jobsRoutes } from './routes/jobs.js';
import { closeWorkers } from './worker/index.js';
import { closeBrowser } from './worker/playwright.singleton.js';
import { httpAgent } from './scraper/http-client.js';
import { db } from './db/index.js';

const env = parseEnv();

const app = Fastify({
  logger: env.NODE_ENV === 'production'
    ? { level: 'info' }
    : {
        level: 'debug',
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
        },
      },
});

// Create the ioredis client for job status caching
const redis = new IORedis(env.REDIS_URL);

// Decorate Fastify instance with shared resources accessible in route handlers
app.decorate('redis', redis);
app.decorate('config', env);

// Register routes
await app.register(healthRoutes);
await app.register(scrapeRoutes);
await app.register(mediaRoutes);
await app.register(jobsRoutes);

// Add x-request-id header to every response (Fastify auto-generates request.id)
app.addHook('onSend', async (request, reply) => {
  reply.header('x-request-id', request.id as string);
});

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
