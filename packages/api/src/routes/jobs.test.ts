import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// Mock repository before any dynamic imports
jest.unstable_mockModule('../db/repositories/job.repository.js', () => ({
  jobRepository: {
    findPaginated: jest.fn(),
  },
}));

// Dynamic imports after mocking
const { jobsRoutes } = await import('./jobs.js');
const { jobRepository } = await import('../db/repositories/job.repository.js');

const mockFindPaginated = jobRepository.findPaginated as jest.MockedFunction<
  typeof jobRepository.findPaginated
>;

const makeJob = (overrides: object = {}) => ({
  id: 'job-1',
  status: 'done' as const,
  browserFallback: false,
  maxScrollDepth: 10,
  urlsTotal: 5,
  urlsDone: 5,
  urlsSpaDetected: 0,
  urlsBrowserDone: 0,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  finishedAt: new Date('2026-01-01T00:01:00Z'),
  ...overrides,
});

describe('GET /api/jobs', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    await app.register(jobsRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    jest.clearAllMocks();
  });

  it('returns 400 when status param is missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/jobs' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when status param is invalid', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/jobs?status=running' });
    expect(res.statusCode).toBe(400);
  });

  it('queries with ACTIVE_STATUSES when status=active', async () => {
    mockFindPaginated.mockResolvedValue({ rows: [], total: 0 });

    await app.inject({ method: 'GET', url: '/api/jobs?status=active' });

    expect(mockFindPaginated).toHaveBeenCalledWith(
      expect.objectContaining({
        statuses: ['pending', 'running', 'fast_complete'],
        orderBy: 'createdAt',
        page: 1,
        limit: 20,
      }),
    );
  });

  it('queries with DONE_STATUSES and finishedAt order when status=done', async () => {
    mockFindPaginated.mockResolvedValue({ rows: [], total: 0 });

    await app.inject({ method: 'GET', url: '/api/jobs?status=done' });

    expect(mockFindPaginated).toHaveBeenCalledWith(
      expect.objectContaining({
        statuses: ['done', 'failed'],
        orderBy: 'finishedAt',
      }),
    );
  });

  it('returns paginated job DTOs with urlsBrowserPending derived', async () => {
    const job = makeJob({ urlsSpaDetected: 3, urlsBrowserDone: 1 });
    mockFindPaginated.mockResolvedValue({ rows: [job], total: 1 });

    const res = await app.inject({ method: 'GET', url: '/api/jobs?status=done' });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: unknown[]; pagination: unknown }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      jobId: 'job-1',
      urlsBrowserPending: 2, // 3 - 1
      finishedAt: '2026-01-01T00:01:00.000Z',
    });
    expect(body.pagination).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
  });

  it('passes page and limit from query string', async () => {
    mockFindPaginated.mockResolvedValue({ rows: [], total: 0 });

    await app.inject({ method: 'GET', url: '/api/jobs?status=active&page=2&limit=10' });

    expect(mockFindPaginated).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2, limit: 10 }),
    );
  });

  it('returns 400 when limit exceeds 50', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/jobs?status=active&limit=51' });
    expect(res.statusCode).toBe(400);
  });

  it('computes totalPages correctly', async () => {
    mockFindPaginated.mockResolvedValue({ rows: [], total: 45 });

    const res = await app.inject({ method: 'GET', url: '/api/jobs?status=done&limit=20' });
    const body = res.json<{ pagination: { totalPages: number } }>();
    expect(body.pagination.totalPages).toBe(3); // ceil(45/20)
  });

  it('returns empty data when repository returns no rows', async () => {
    mockFindPaginated.mockResolvedValue({ rows: [], total: 0 });

    const res = await app.inject({ method: 'GET', url: '/api/jobs?status=active' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: unknown[]; pagination: { totalPages: number } }>();
    expect(body.data).toHaveLength(0);
    expect(body.pagination.totalPages).toBe(1); // Math.max(1, ceil(0/20))
  });
});
