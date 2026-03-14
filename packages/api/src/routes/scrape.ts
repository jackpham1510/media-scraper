import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { Redis as IORedis } from 'ioredis';
import { parseEnv } from '../config/env.js';
import { jobRepository } from '../db/repositories/job.repository.js';
import { requestRepository } from '../db/repositories/request.repository.js';
import { fastQueue, browserQueue } from '../worker/index.js';
import type { FastJobPayload } from '../types/index.js';

// Augment FastifyInstance to carry the shared Redis client and config
declare module 'fastify' {
  interface FastifyInstance {
    redis: IORedis;
    config: ReturnType<typeof parseEnv>;
  }
}

const JOB_STATUS_TTL_SECONDS = 2;

interface ScrapeBody {
  urls: string[];
  options?: {
    browserFallback?: boolean;
    maxScrollDepth?: number;
  };
}

interface JobStatusParams {
  jobId: string;
}

export const scrapeRoutes: FastifyPluginAsync = async (app) => {
  // POST /api/scrape
  // Validates request, checks queue depth, creates DB records, enqueues BullMQ job
  app.post<{ Body: ScrapeBody }>(
    '/api/scrape',
    {
      schema: {
        body: {
          type: 'object',
          required: ['urls'],
          properties: {
            urls: {
              type: 'array',
              items: { type: 'string', format: 'uri' },
              minItems: 1,
              maxItems: 5000,
            },
            options: {
              type: 'object',
              properties: {
                browserFallback: { type: 'boolean', default: false },
                maxScrollDepth: { type: 'integer', minimum: 1, maximum: 60, default: 10 },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { urls, options } = request.body;
      const browserFallback = options?.browserFallback ?? false;
      const maxScrollDepth = options?.maxScrollDepth ?? 10;

      // Check queue depth against QUEUE_MAX_DEPTH — return 503 if exceeded.
      // Use Promise.allSettled so a Redis hiccup on one queue doesn't block requests.
      const queueCountResults = await Promise.allSettled([
        fastQueue.getJobCounts('waiting', 'active'),
        browserQueue.getJobCounts('waiting', 'active'),
      ]);

      let totalDepth = 0;
      for (const result of queueCountResults) {
        if (result.status === 'fulfilled') {
          totalDepth += (result.value['waiting'] ?? 0) + (result.value['active'] ?? 0);
        }
        // If rejected (Redis error), treat as 0 — don't block requests on a transient error
      }

      if (totalDepth >= app.config.QUEUE_MAX_DEPTH) {
        return reply
          .status(503)
          .send({ error: 'queue_full', message: 'Server is at capacity' });
      }

      // Create scrape_jobs row
      const jobId = randomUUID();
      await jobRepository.create(jobId, urls.length, browserFallback, maxScrollDepth);

      // Bulk insert URLs into scrape_requests and get IDs back
      const insertedRequests = await requestRepository.bulkInsert(jobId, urls);

      // Build BullMQ payload — BigInt IDs serialized to number for JSON
      const urlsPayload = insertedRequests.map((r) => ({
        id: Number(r.id),
        url: r.url,
      }));

      const payload: FastJobPayload = {
        jobId,
        browserFallback,
        maxScrollDepth,
        urls: urlsPayload,
      };

      await fastQueue.add('scrape-urls', payload, { priority: 1 });

      return reply.status(202).send({ jobId });
    },
  );

  // GET /api/scrape/:jobId
  // Returns job status DTO with Redis caching (2s TTL)
  app.get<{ Params: JobStatusParams }>(
    '/api/scrape/:jobId',
    async (request, reply) => {
      const { jobId } = request.params;
      const cacheKey = `job:status:${jobId}`;

      // Try Redis cache first (2s TTL)
      const cached = await app.redis.get(cacheKey);
      if (cached !== null) {
        const parsed: unknown = JSON.parse(cached);
        return reply.send(parsed);
      }

      // Cache miss — fetch from DB
      const job = await jobRepository.findById(jobId);
      if (job === null) {
        return reply.status(404).send({ error: 'not_found', message: 'Job not found' });
      }

      const dto = {
        jobId: job.id,
        status: job.status,
        urlsTotal: job.urlsTotal,
        urlsDone: job.urlsDone,
        urlsSpaDetected: job.urlsSpaDetected,
        urlsBrowserDone: job.urlsBrowserDone,
        urlsBrowserPending: job.urlsSpaDetected - job.urlsBrowserDone,
        createdAt: job.createdAt.toISOString(),
        finishedAt: job.finishedAt !== null ? job.finishedAt.toISOString() : null,
      };

      // Cache result for 2s
      await app.redis.set(cacheKey, JSON.stringify(dto), 'EX', JOB_STATUS_TTL_SECONDS);

      return reply.send(dto);
    },
  );
};
