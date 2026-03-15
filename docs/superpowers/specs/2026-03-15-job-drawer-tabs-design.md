# Job Drawer Tabs — Design Spec

**Date:** 2026-03-15
**Status:** Approved

---

## Overview

Replace the current flat job list in `JobsDrawer` with a two-tab interface (Active / History), backed by server-side job listing APIs. Deprecate in-memory job tracking in favour of polling the DB directly.

---

## Goals

- Active tab shows all in-progress jobs (pending / running / fast_complete) from the DB.
- History tab shows all completed/failed jobs from the DB, loaded lazily on first open.
- Both tabs support pagination.
- Active jobs are batch-polled (one request per interval) instead of one request per job.
- Red badge on the Activity button reflects only active job count, kept fresh via polling.
- When any active job transitions to `done`, the media list is invalidated automatically.

---

## API Contract

### `GET /api/jobs`

Paginated job listing.

**Query parameters:**

| Param  | Type              | Default | Description                                      |
|--------|-------------------|---------|--------------------------------------------------|
| status | `active` \| `done` | —      | Required. `active` = pending/running/fast_complete; `done` = done/failed |
| page   | number            | 1       | 1-based page index                               |
| limit  | number            | 20      | Max 50                                           |

**Response `200`:**

```json
{
  "data": [JobStatusDTO],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 42,
    "totalPages": 3
  }
}
```

`JobStatusDTO` is the same shape as the existing `GET /api/scrape/:jobId` response:
`{ jobId, status, urlsTotal, urlsDone, urlsSpaDetected, urlsBrowserDone, urlsBrowserPending, createdAt, finishedAt }`

**Ordering:**
- `status=active` → `ORDER BY createdAt DESC`
- `status=done` → `ORDER BY finishedAt DESC`

---

### `GET /api/jobs/stats`

Returns the count of currently active jobs.

**Response `200`:**

```json
{ "activeCount": 5 }
```

No caching. Uses indexed `COUNT(*)` on `status`.

---

## Backend Changes

### `packages/api/src/db/repositories/job.repository.ts`

Two new methods added:

```typescript
findPaginated(filter: {
  statuses: JobStatus[]
  page: number
  limit: number
  orderBy: 'createdAt' | 'finishedAt'
}): Promise<{ rows: ScrapeJob[]; total: number }>

countActive(): Promise<number>
```

Both rely on existing indexes: `idx_status`, `idx_created_at`.

### `packages/api/src/routes/jobs.ts` (new file)

Fastify route plugin registered at prefix `/api/jobs`:

- `GET /` — validates query params (Zod), calls `findPaginated`, maps rows to `JobStatusDTO[]`, returns pagination envelope.
- `GET /stats` — calls `countActive`, returns `{ activeCount }`.

Registered in `app.ts` alongside `scrape.ts`. No Redis caching on either route.

**No changes** to `scrape.ts` or any worker file.

---

## Frontend Changes

### `packages/web/src/api/client.ts`

Two new methods:

```typescript
getJobs(status: 'active' | 'done', page: number, limit?: number): Promise<JobListResponse>
getJobStats(): Promise<{ activeCount: number }>
```

### New hooks

**`useJobs(status, page)`** (`packages/web/src/hooks/useJobs.ts`)

- Wraps `api.getJobs()` via TanStack Query.
- Key: `['jobs', status, page]`
- When `status === 'active'`: `refetchInterval: 3000`
- When `status === 'done'`: no refetch interval (fetch once on tab open)
- On each successful fetch, compares previous data to current data; if any job moved to `done`/`failed`, calls `queryClient.invalidateQueries(['media'])`.

**`useJobStats()`** (`packages/web/src/hooks/useJobStats.ts`)

- Wraps `api.getJobStats()` via TanStack Query.
- Key: `['jobs', 'stats']`
- `refetchInterval: 3000`
- Drives the red badge on the Activity button.

### Deprecated / removed

- `useActiveJobs` — removed entirely. No more local job ID tracking.
- `useJobStatus(jobId)` — removed. Individual polling replaced by batch listing.

### `packages/web/src/components/JobsDrawer.tsx`

**Structural changes:**

- Add two tabs: **Active** (default) / **History**.
- Active tab:
  - Renders jobs from `useJobs('active', page)`.
  - Polls every 3s automatically via hook.
  - Shows progress bar + status badge per job (same as current).
  - Pagination controls at bottom (previous / next, current page / total pages).
- History tab:
  - Mounts lazily — `useJobs('done', page)` is only called when tab is first opened.
  - Shows finished jobs with `finishedAt` timestamp.
  - Pagination controls at bottom.
- Remove per-job dismiss (X button) and "Clear All" button — no longer needed.

### Activity button badge

- Reads `useJobStats().data?.activeCount ?? 0`.
- Shown only when `activeCount > 0`.
- Updates every ~3s via the stats hook polling.

### `packages/web/src/pages/HomePage.tsx`

- Remove `useActiveJobs` usage.
- Remove passing `trackedJobs` to `JobsDrawer`.
- `ScrapeModal` on submit no longer calls `addJob(jobId)` — the new job will appear in the Active tab on next poll.

---

## Data Flow

```
[Activity button]
  └── useJobStats() polls /api/jobs/stats every 3s → badge count

[JobsDrawer — Active tab]
  └── useJobs('active', page) polls /api/jobs?status=active every 3s
        └── on job status change to done → invalidate ['media'] query

[JobsDrawer — History tab] (lazy — only when first opened)
  └── useJobs('done', page) fetches /api/jobs?status=done once per page change
```

---

## Out of Scope

- WebSocket / SSE real-time updates (polling is sufficient).
- Per-job URL error breakdown in the drawer.
- Job cancellation.
- Auth / per-user job isolation (no auth in this project).
