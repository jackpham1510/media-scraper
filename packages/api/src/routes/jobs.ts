import type { FastifyPluginAsync } from 'fastify';
import { jobRepository } from '../db/repositories/job.repository.js';
import type { JobStatus } from '../types/index.js';

const ACTIVE_STATUSES: JobStatus[] = ['pending', 'running', 'fast_complete'];
const DONE_STATUSES: JobStatus[] = ['done', 'failed'];

interface JobsQuery {
  status: 'active' | 'done';
  page?: number;
  limit?: number;
}

export const jobsRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/jobs/stats — must be registered before GET /api/jobs to avoid shadowing
  app.get('/api/jobs/stats', async (_request, reply) => {
    const activeCount = await jobRepository.countActive();
    return reply.send({ activeCount });
  });

  // GET /api/jobs
  app.get<{ Querystring: JobsQuery }>(
    '/api/jobs',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['status'],
          properties: {
            status: { type: 'string', enum: ['active', 'done'] },
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
          },
        },
      },
    },
    async (request, reply) => {
      const { status, page = 1, limit = 20 } = request.query;

      const statuses = status === 'active' ? ACTIVE_STATUSES : DONE_STATUSES;
      const orderBy = status === 'active' ? 'createdAt' : 'finishedAt';

      const { rows, total } = await jobRepository.findPaginated({
        statuses,
        page,
        limit,
        orderBy,
      });

      const data = rows.map((job) => ({
        jobId: job.id,
        status: job.status,
        urlsTotal: job.urlsTotal,
        urlsDone: job.urlsDone,
        urlsSpaDetected: job.urlsSpaDetected,
        urlsBrowserDone: job.urlsBrowserDone,
        urlsBrowserPending: Math.max(0, job.urlsSpaDetected - job.urlsBrowserDone),
        createdAt: job.createdAt.toISOString(),
        finishedAt: job.finishedAt !== null ? job.finishedAt.toISOString() : null,
      }));

      const totalPages = Math.max(1, Math.ceil(total / limit));

      return reply.send({
        data,
        pagination: { page, limit, total, totalPages },
      });
    },
  );
};
