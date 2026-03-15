# Job Drawer Tabs Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat in-memory job list in `JobsDrawer` with a server-driven Active/History two-tab interface backed by two new paginated API endpoints.

**Architecture:** Two new API routes (`GET /api/jobs` and `GET /api/jobs/stats`) read from MySQL via two new repository methods. The frontend replaces `useActiveJobs` (local state) with `useJobs` and `useJobStats` (TanStack Query polling). `JobsDrawer` renders two tabs with pagination. `useJobStatus` is retained for `ScrapeModal`'s in-modal progress display only.

**Tech Stack:** Fastify, Prisma raw SQL, BullMQ, TanStack Query v5, React 19, Tailwind, shadcn/ui (Sheet, Badge, Progress, Button)

**Spec:** `docs/superpowers/specs/2026-03-15-job-drawer-tabs-design.md`

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `packages/api/prisma/schema.prisma` | Add `idx_finished_at` index |
| Modify | `packages/api/src/db/repositories/job.repository.ts` | Add `findPaginated`, `countActive` |
| **Create** | `packages/api/src/routes/jobs.ts` | `GET /api/jobs/stats` and `GET /api/jobs` |
| Modify | `packages/api/src/main.ts` | Register `jobsRoutes` |
| **Create** | `packages/api/src/routes/jobs.test.ts` | Route unit tests (mocked repository) |
| Modify | `packages/web/src/types.ts` | Add `JobListResponse` |
| Modify | `packages/web/src/api/client.ts` | Add `getJobs`, `getJobStats` |
| **Create** | `packages/web/src/hooks/useJobStats.ts` | Poll `/api/jobs/stats` every 3s |
| **Create** | `packages/web/src/hooks/useJobs.ts` | Paginated job listing, transition detection |
| Modify | `packages/web/src/components/JobsDrawer.tsx` | Full rewrite: tabs, pagination, server-driven |
| Modify | `packages/web/src/pages/HomePage.tsx` | Remove `useActiveJobs`, simplify props |
| Delete | `packages/web/src/hooks/useActiveJobs.ts` | No longer needed |

---

## Chunk 1: Backend

### Task 1: DB Migration — add `idx_finished_at`

**Files:**
- Modify: `packages/api/prisma/schema.prisma`

- [ ] **Step 1: Add the index to the Prisma schema**

  In `packages/api/prisma/schema.prisma`, find the `ScrapeJob` model and add the index after the existing ones:

  ```prisma
  @@index([createdAt], name: "idx_created_at")
  @@index([finishedAt], name: "idx_finished_at")   // <-- add this line
  @@map("scrape_jobs")
  ```

- [ ] **Step 2: Run the migration**

  ```bash
  npm run db:migrate -w packages/api
  ```

  When prompted for a migration name, enter: `add_idx_finished_at`

  Expected: migration file created under `packages/api/prisma/migrations/`, MySQL index created.

- [ ] **Step 3: Regenerate Prisma client**

  ```bash
  npm run db:generate -w packages/api
  ```

  Expected: `node_modules/.prisma/client` updated.

- [ ] **Step 4: Commit**

  ```bash
  git add packages/api/prisma/schema.prisma packages/api/prisma/migrations/
  git commit -m "feat(db): add idx_finished_at index on scrape_jobs"
  ```

---

### Task 2: Repository — `findPaginated` and `countActive`

**Files:**
- Modify: `packages/api/src/db/repositories/job.repository.ts`

- [ ] **Step 1: Add `findPaginated` and `countActive` to the repository**

  Open `packages/api/src/db/repositories/job.repository.ts`. After the closing brace of `transitionAfterFastComplete` (line 154), add two new methods inside the `jobRepository` object before the closing `};`:

  ```typescript
  async findPaginated(filter: {
    statuses: JobStatus[];
    page: number;
    limit: number;
    orderBy: 'createdAt' | 'finishedAt';
  }): Promise<{ rows: ScrapeJobDto[]; total: number }> {
    if (filter.statuses.length === 0) return { rows: [], total: 0 };
    const placeholders = filter.statuses.map(() => '?').join(', ');
    const orderCol = filter.orderBy === 'finishedAt' ? 'finished_at' : 'created_at';
    const offset = (filter.page - 1) * filter.limit;

    const [rawRows, rawCount]: [unknown, unknown] = await Promise.all([
      db.$queryRawUnsafe(
        `SELECT id, status, browser_fallback, max_scroll_depth,
                urls_total, urls_done, urls_spa_detected, urls_browser_done,
                created_at, finished_at
         FROM scrape_jobs
         WHERE status IN (${placeholders})
         ORDER BY ${orderCol} DESC
         LIMIT ? OFFSET ?`,
        ...filter.statuses,
        filter.limit,
        offset,
      ),
      db.$queryRawUnsafe(
        `SELECT COUNT(*) AS total FROM scrape_jobs WHERE status IN (${placeholders})`,
        ...filter.statuses,
      ),
    ]);

    const rows = (rawRows as RawJobRow[]).map(rowToDto);
    const total = Number((rawCount as Array<{ total: bigint | number }>)[0]?.total ?? 0);
    return { rows, total };
  },

  async countActive(): Promise<number> {
    const raw: unknown = await db.$queryRawUnsafe(
      `SELECT COUNT(*) AS total FROM scrape_jobs
       WHERE status IN ('pending', 'running', 'fast_complete')`,
    );
    return Number((raw as Array<{ total: bigint | number }>)[0]?.total ?? 0);
  },
  ```

- [ ] **Step 2: Verify TypeScript compiles**

  ```bash
  npm run typecheck -w packages/api
  ```

  Expected: no errors.

- [ ] **Step 3: Commit**

  ```bash
  git add packages/api/src/db/repositories/job.repository.ts
  git commit -m "feat(repo): add findPaginated and countActive to jobRepository"
  ```

---

### Task 3: Route — `GET /api/jobs` and `GET /api/jobs/stats`

**Files:**
- Create: `packages/api/src/routes/jobs.ts`

This is a new Fastify plugin. Model it after `scrape.ts`. The jobs routes do **not** need `redis` or `config` from the Fastify instance — they only call the repository.

  > **Routing convention:** This codebase uses full-path routes (e.g. `/api/jobs`) registered without a `prefix`, matching the pattern in `scrape.ts` and `media.ts`. Do not use Fastify's `register` prefix option.

- [ ] **Step 1: Create `packages/api/src/routes/jobs.ts`**

  ```typescript
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
          urlsBrowserPending: job.urlsSpaDetected - job.urlsBrowserDone,
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
  ```

- [ ] **Step 2: Verify TypeScript compiles**

  ```bash
  npm run typecheck -w packages/api
  ```

  Expected: no errors.

---

### Task 4: Register `jobsRoutes` in `main.ts`

**Files:**
- Modify: `packages/api/src/main.ts`

- [ ] **Step 1: Import and register `jobsRoutes`**

  Add the import at the top of `packages/api/src/main.ts` after the existing route imports:

  ```typescript
  import { jobsRoutes } from './routes/jobs.js';
  ```

  Then register it after the existing route registrations (after line 36, `await app.register(mediaRoutes)`):

  ```typescript
  await app.register(jobsRoutes);
  ```

- [ ] **Step 2: Verify TypeScript compiles**

  ```bash
  npm run typecheck -w packages/api
  ```

  Expected: no errors.

---

### Task 5: Tests for `jobs.ts` routes

**Files:**
- Create: `packages/api/src/routes/jobs.test.ts`

The test strategy: mock `jobRepository` using Jest's `unstable_mockModule` (required for ESM), dynamically import the route after mocking, use Fastify injection exactly as in `health.test.ts`.

  > **ESM mock note:** This is the first test in this repo to use `jest.unstable_mockModule`. The `--experimental-vm-modules` flag is already present in `packages/api/package.json`'s test script — verify with `grep experimental-vm-modules packages/api/package.json` before running.

- [ ] **Step 1: Write the tests**

  Create `packages/api/src/routes/jobs.test.ts`:

  ```typescript
  import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
  import Fastify from 'fastify';
  import type { FastifyInstance } from 'fastify';

  // Mock repository before any dynamic imports
  jest.unstable_mockModule('../db/repositories/job.repository.js', () => ({
    jobRepository: {
      findPaginated: jest.fn(),
      countActive: jest.fn(),
    },
  }));

  // Dynamic imports after mocking
  const { jobsRoutes } = await import('./jobs.js');
  const { jobRepository } = await import('../db/repositories/job.repository.js');

  const mockFindPaginated = jobRepository.findPaginated as jest.MockedFunction<
    typeof jobRepository.findPaginated
  >;
  const mockCountActive = jobRepository.countActive as jest.MockedFunction<
    typeof jobRepository.countActive
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

  describe('GET /api/jobs/stats', () => {
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

    it('returns activeCount from repository', async () => {
      mockCountActive.mockResolvedValue(3);

      const res = await app.inject({ method: 'GET', url: '/api/jobs/stats' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ activeCount: 3 });
      expect(mockCountActive).toHaveBeenCalledTimes(1);
    });
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
  ```

- [ ] **Step 2: Run the tests**

  ```bash
  npm run test -w packages/api -- --testPathPattern=jobs.test
  ```

  Expected: all tests pass.

- [ ] **Step 3: Commit**

  ```bash
  git add packages/api/src/routes/jobs.ts packages/api/src/routes/jobs.test.ts
  git commit -m "feat(api): add GET /api/jobs and GET /api/jobs/stats routes"
  ```

  > `main.ts` was already committed in Task 4. Only add it here if you skipped Task 4's commit step.

---

## Chunk 2: Frontend

### Task 6: Frontend types

**Files:**
- Modify: `packages/web/src/types.ts`

- [ ] **Step 1: Add `JobListResponse` to types**

  Open `packages/web/src/types.ts`. After the `MediaResponse` interface (end of file), add:

  ```typescript
  export interface JobListResponse {
    data: JobStatus[];
    pagination: Pagination;
  }
  ```

- [ ] **Step 2: Verify TypeScript**

  ```bash
  npm run typecheck -w packages/web
  ```

  Expected: no errors.

---

### Task 7: API client methods

**Files:**
- Modify: `packages/web/src/api/client.ts`

- [ ] **Step 1: Add `getJobs` and `getJobStats` to the `api` object**

  Open `packages/web/src/api/client.ts`. Add the import for `JobListResponse` at line 1:

  ```typescript
  import type { JobStatus, JobListResponse, MediaFilters, MediaResponse } from '../types.js';
  ```

  Then add two methods to the `api` object, after `getJobStatus`:

  ```typescript
  async getJobs(
    status: 'active' | 'done',
    page: number,
    limit = 20,
  ): Promise<JobListResponse> {
    const params = new URLSearchParams({ status, page: String(page), limit: String(limit) });
    return request<JobListResponse>(`/api/jobs?${params.toString()}`);
  },

  async getJobStats(): Promise<{ activeCount: number }> {
    return request<{ activeCount: number }>('/api/jobs/stats');
  },
  ```

- [ ] **Step 2: Verify TypeScript**

  ```bash
  npm run typecheck -w packages/web
  ```

  Expected: no errors.

---

### Task 8: `useJobStats` hook

**Files:**
- Create: `packages/web/src/hooks/useJobStats.ts`

- [ ] **Step 1: Create the hook**

  Create `packages/web/src/hooks/useJobStats.ts`:

  ```typescript
  import { useQuery } from '@tanstack/react-query';
  import { api } from '../api/client.js';

  export function useJobStats(): { activeCount: number } {
    const { data } = useQuery({
      queryKey: ['jobStats'],
      queryFn: () => api.getJobStats(),
      refetchInterval: 3000,
      retry: false,
    });
    return { activeCount: data?.activeCount ?? 0 };
  }
  ```

- [ ] **Step 2: Verify TypeScript**

  ```bash
  npm run typecheck -w packages/web
  ```

  Expected: no errors.

---

### Task 9: `useJobs` hook

**Files:**
- Create: `packages/web/src/hooks/useJobs.ts`

This hook handles both active (polling) and done (fetch-once) queries. For active status, it detects when jobs leave the list (completed) and fires a toast + media invalidation.

- [ ] **Step 1: Create the hook**

  Create `packages/web/src/hooks/useJobs.ts`:

  ```typescript
  import { useEffect, useRef } from 'react';
  import { useQuery, useQueryClient } from '@tanstack/react-query';
  import { toast } from 'sonner';
  import { api } from '../api/client.js';
  import type { JobListResponse, JobStatus } from '../types.js';

  export function useJobs(
    status: 'active' | 'done',
    page: number,
    options?: { enabled?: boolean },
  ): ReturnType<typeof useQuery<JobListResponse>> {
    const queryClient = useQueryClient();
    const prevJobsRef = useRef<Map<string, JobStatus>>(new Map());

    const query = useQuery<JobListResponse>({
      queryKey: ['jobList', status, page],
      queryFn: () => api.getJobs(status, page),
      refetchInterval: status === 'active' ? 3000 : undefined,
      staleTime: status === 'done' ? Infinity : 0,
      retry: false,
      enabled: options?.enabled !== false,
    });

    // Detect active jobs that have left the list (completed/failed) and fire side effects
    useEffect(() => {
      if (status !== 'active' || query.data === undefined) return;

      const currentIds = new Set(query.data.data.map((j) => j.jobId));
      const prev = prevJobsRef.current;

      for (const [jobId] of prev) {
        if (!currentIds.has(jobId)) {
          // Job left the active list — it completed or failed
          void queryClient.invalidateQueries({ queryKey: ['media'] });
          toast.success('Job completed', {
            description: `Job ${jobId.slice(0, 8)}… finished`,
          });
        }
      }

      // Update snapshot
      const next = new Map<string, JobStatus>();
      for (const job of query.data.data) {
        next.set(job.jobId, job);
      }
      prevJobsRef.current = next;
    }, [query.data, status, queryClient]);

    return query;
  }
  ```

- [ ] **Step 2: Verify TypeScript**

  ```bash
  npm run typecheck -w packages/web
  ```

  Expected: no errors.

---

### Task 10: Rewrite `JobsDrawer`

**Files:**
- Modify: `packages/web/src/components/JobsDrawer.tsx`

Full replacement of the component. Tabs are implemented with a simple `activeTab` state + Tailwind styling (no separate Tabs component needed). `JobRow` is rewritten to accept a `JobStatus` directly instead of calling `useJobStatus`.

- [ ] **Step 1: Replace `JobsDrawer.tsx` entirely**

  Replace the full contents of `packages/web/src/components/JobsDrawer.tsx` with:

  ```typescript
  import type React from 'react';
  import { useState } from 'react';
  import { Inbox, ChevronLeft, ChevronRight } from 'lucide-react';
  import { useJobs } from '../hooks/useJobs.js';
  import type { JobStatus, JobStatusValue } from '../types.js';
  import { Progress } from './ui/progress.js';
  import { Badge } from './ui/badge.js';
  import { Button } from './ui/button.js';
  import { cn } from '../lib/utils.js';
  import {
    Sheet, SheetContent, SheetHeader, SheetTitle,
  } from './ui/sheet.js';

  type Tab = 'active' | 'done';

  function statusLabel(s: JobStatusValue): string {
    switch (s) {
      case 'pending': return 'Pending';
      case 'running': return 'Running';
      case 'fast_complete': return 'Processing SPAs';
      case 'done': return 'Complete';
      case 'failed': return 'Failed';
    }
  }

  function statusVariant(s: JobStatusValue): 'default' | 'secondary' | 'warning' | 'success' | 'destructive' {
    switch (s) {
      case 'pending': return 'secondary';
      case 'running': return 'warning';
      case 'fast_complete': return 'warning';
      case 'done': return 'success';
      case 'failed': return 'destructive';
    }
  }

  function JobRow({ job }: { job: JobStatus }): React.JSX.Element {
    const progress = Math.round((job.urlsDone / Math.max(job.urlsTotal, 1)) * 100);
    return (
      <div className="rounded-lg border border-border bg-card p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-mono text-muted-foreground truncate flex-1">
            {job.jobId.slice(0, 12)}…
          </span>
          <Badge variant={statusVariant(job.status)} className="text-xs">
            {statusLabel(job.status)}
          </Badge>
        </div>
        <Progress value={progress} className="h-1.5" />
        <p className="text-xs text-muted-foreground">
          {job.urlsDone} / {job.urlsTotal} URLs
          {job.urlsBrowserPending > 0 && ` · ${job.urlsBrowserPending} SPA pending`}
        </p>
        {job.finishedAt !== null && (
          <p className="text-xs text-muted-foreground">
            Finished {new Date(job.finishedAt).toLocaleTimeString()}
          </p>
        )}
      </div>
    );
  }

  function PaginationControls({
    page,
    totalPages,
    onPage,
  }: {
    page: number;
    totalPages: number;
    onPage: (p: number) => void;
  }): React.JSX.Element | null {
    if (totalPages <= 1) return null;
    return (
      <div className="flex items-center justify-center gap-1 pt-2 border-t">
        <Button
          variant="outline"
          size="icon"
          className="h-7 w-7"
          onClick={() => onPage(Math.max(1, page - 1))}
          disabled={page === 1}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        <span className="text-xs text-muted-foreground px-2">
          {page} / {totalPages}
        </span>
        <Button
          variant="outline"
          size="icon"
          className="h-7 w-7"
          onClick={() => onPage(Math.min(totalPages, page + 1))}
          disabled={page === totalPages}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  function TabContent({ tab }: { tab: Tab }): React.JSX.Element {
    const [page, setPage] = useState(1);
    const { data, isLoading, isError } = useJobs(tab, page);

    const jobs = data?.data ?? [];
    const totalPages = data?.pagination.totalPages ?? 1;

    if (isLoading) {
      return (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground space-y-2">
          <p className="text-sm animate-pulse">Loading…</p>
        </div>
      );
    }

    if (isError && jobs.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground space-y-2">
          <p className="text-sm text-destructive">Failed to load jobs</p>
        </div>
      );
    }

    if (jobs.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground space-y-2">
          <Inbox className="h-8 w-8 opacity-40" />
          <p className="text-sm">{tab === 'active' ? 'No active jobs' : 'No completed jobs'}</p>
        </div>
      );
    }

    return (
      <>
        <div className="flex-1 overflow-y-auto space-y-3">
          {jobs.map((job) => <JobRow key={job.jobId} job={job} />)}
        </div>
        <PaginationControls page={page} totalPages={totalPages} onPage={setPage} />
      </>
    );
  }

  function HistoryTabContent(): React.JSX.Element {
    const [page, setPage] = useState(1);
    const { data, isLoading, isError } = useJobs('done', page);

    const jobs = data?.data ?? [];
    const totalPages = data?.pagination.totalPages ?? 1;

    if (isLoading) {
      return (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <p className="text-sm animate-pulse">Loading…</p>
        </div>
      );
    }

    if (isError && jobs.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <p className="text-sm text-destructive">Failed to load history</p>
        </div>
      );
    }

    if (jobs.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground space-y-2">
          <Inbox className="h-8 w-8 opacity-40" />
          <p className="text-sm">No completed jobs</p>
        </div>
      );
    }

    return (
      <>
        <div className="flex-1 overflow-y-auto space-y-3">
          {jobs.map((job) => <JobRow key={job.jobId} job={job} />)}
        </div>
        <PaginationControls page={page} totalPages={totalPages} onPage={setPage} />
      </>
    );
  }

  export interface JobsDrawerProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }

  export function JobsDrawer({ open, onOpenChange }: JobsDrawerProps): React.JSX.Element {
    const [activeTab, setActiveTab] = useState<Tab>('active');
    const [historyEverOpened, setHistoryEverOpened] = useState(false);

    const [activePage, setActivePage] = useState(1);
    const [historyPage, setHistoryPage] = useState(1);

    const activeQuery = useJobs('active', activePage);
    const historyQuery = useJobs('done', historyPage, { enabled: historyEverOpened });

    const handleTabChange = (tab: Tab): void => {
      setActiveTab(tab);
      if (tab === 'done' && !historyEverOpened) setHistoryEverOpened(true);
    };

    const currentQuery = activeTab === 'active' ? activeQuery : historyQuery;
    const jobs = currentQuery.data?.data ?? [];
    const totalPages = currentQuery.data?.pagination.totalPages ?? 1;
    const page = activeTab === 'active' ? activePage : historyPage;
    const setPage = activeTab === 'active' ? setActivePage : setHistoryPage;

    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-80 sm:max-w-sm flex flex-col">
          <SheetHeader>
            <SheetTitle>Activity</SheetTitle>
          </SheetHeader>

          {/* Tab bar */}
          <div className="flex gap-1 mt-3 rounded-lg bg-muted p-1">
            {(['active', 'done'] as Tab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => handleTabChange(tab)}
                className={cn(
                  'flex-1 px-3 py-1 rounded-md text-sm font-medium transition-colors',
                  activeTab === tab
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {tab === 'active' ? 'Active' : 'History'}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="flex flex-col flex-1 min-h-0 mt-3 gap-3">
            {currentQuery.isLoading ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <p className="text-sm animate-pulse">Loading…</p>
              </div>
            ) : currentQuery.isError && jobs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <p className="text-sm text-destructive">Failed to load jobs</p>
              </div>
            ) : jobs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground space-y-2">
                <Inbox className="h-8 w-8 opacity-40" />
                <p className="text-sm">
                  {activeTab === 'active' ? 'No active jobs' : 'No completed jobs'}
                </p>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto space-y-3">
                {jobs.map((job) => <JobRow key={job.jobId} job={job} />)}
              </div>
            )}

            <PaginationControls page={page} totalPages={totalPages} onPage={setPage} />
          </div>
        </SheetContent>
      </Sheet>
    );
  }
  ```

- [ ] **Step 2: Remove the unused `TabContent` and `HistoryTabContent` components from the file**

  The code block above contains two scaffolding components (`TabContent` and `HistoryTabContent`) that were replaced by inlining the logic directly into `JobsDrawer`. They must be deleted before saving.

  The final file must contain **only these top-level declarations** (in order):
  1. imports
  2. `type Tab`
  3. `statusLabel()`
  4. `statusVariant()`
  5. `JobRow()`
  6. `PaginationControls()`
  7. `JobsDrawerProps` interface
  8. `JobsDrawer()`

  Delete any other component definitions — specifically, delete the `function TabContent` and `function HistoryTabContent` blocks entirely.

- [ ] **Step 3: Verify TypeScript**

  ```bash
  npm run typecheck -w packages/web
  ```

  Expected: no errors. If there are errors about `cn` — it's already imported in the file above. If errors about `useJobs` return type, make sure the `useJobs.ts` from Task 9 is in place.

---

### Task 11: Clean up `HomePage`

**Files:**
- Modify: `packages/web/src/pages/HomePage.tsx`
- Delete: `packages/web/src/hooks/useActiveJobs.ts`

- [ ] **Step 1: Update `HomePage.tsx`**

  Make these targeted changes to `packages/web/src/pages/HomePage.tsx`:

  **a) Replace imports** — remove `useActiveJobs`, add `useJobStats`:

  ```typescript
  // Remove this line:
  import { useActiveJobs } from '../hooks/useActiveJobs.js';

  // Add this line (after the useMedia import):
  import { useJobStats } from '../hooks/useJobStats.js';
  ```

  **b) Replace `useActiveJobs` usage** — find and replace:

  ```typescript
  // Remove:
  const { trackedJobs, addJob, removeJob } = useActiveJobs();

  // Add:
  const { activeCount } = useJobStats();
  ```

  **c) Remove `handleJobStarted`** — delete lines 50–52:

  ```typescript
  // Remove this entire function:
  const handleJobStarted = (jobId: string): void => {
    addJob(jobId);
  };
  ```

  **d) Replace `activeJobCount`** — find:

  ```typescript
  const activeJobCount = trackedJobs.length;
  ```

  Replace with: *(delete this line entirely — use `activeCount` directly below)*

  **e) Update badge reference** — find `activeJobCount > 0` and replace with `activeCount > 0`:

  ```typescript
  {activeCount > 0 && (
    <span className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">
      {activeCount}
    </span>
  )}
  ```

  **f) Update `ScrapeModal`** — remove `onJobStarted` prop:

  ```tsx
  // Remove onJobStarted prop:
  <ScrapeModal
    open={scrapeOpen}
    onOpenChange={setScrapeOpen}
  />
  ```

  **g) Update `JobsDrawer`** — remove `trackedJobs` and `onRemoveJob` props:

  ```tsx
  <JobsDrawer
    open={jobsOpen}
    onOpenChange={setJobsOpen}
  />
  ```

- [ ] **Step 2: Make `onJobStarted` optional in `ScrapeModal.tsx`**

  `onJobStarted` is a required prop in `ScrapeModal`. Make it optional so `HomePage` can stop passing it.

  In `packages/web/src/components/ScrapeModal.tsx`, find the props interface and change:

  ```typescript
  onJobStarted: (jobId: string) => void;
  ```

  to:

  ```typescript
  onJobStarted?: (jobId: string) => void;
  ```

  Then find the call site inside the component (where the job result is used after submission) and add optional chaining:

  ```typescript
  onJobStarted?.(result.jobId);
  ```

  (`result.jobId` may differ — find the existing `onJobStarted(...)` call and add `?` before the `(`)

- [ ] **Step 3: Delete `useActiveJobs.ts`**

  ```bash
  rm packages/web/src/hooks/useActiveJobs.ts
  ```

- [ ] **Step 4: Verify TypeScript**

  ```bash
  npm run typecheck -w packages/web
  ```

  Expected: no errors.

- [ ] **Step 5: Final commit**

  ```bash
  git add packages/web/src/
  git commit -m "feat(web): replace in-memory job tracking with server-driven Active/History tabs"
  ```

---

## Final Verification

- [ ] **Run all backend tests**

  ```bash
  npm run test -w packages/api
  ```

  Expected: all tests pass.

- [ ] **Run full typecheck**

  ```bash
  npm run typecheck -w packages/api && npm run typecheck -w packages/web
  ```

  Expected: no errors in either package.

- [ ] **Smoke test (manual)** — start the stack and verify:

  ```bash
  docker compose up
  ```

  1. Open the UI, click "Activity" — drawer opens showing Active tab (empty or with real jobs)
  2. Start a scrape job — within 3s it appears in Active tab without any page refresh
  3. Red badge on Activity button shows count of active jobs; disappears when jobs complete
  4. Switch to History tab — completed jobs appear
  5. Paginate both tabs
  6. Verify media grid refreshes automatically when a job completes
