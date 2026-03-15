# Job Drawer Tabs — Design Spec

**Date:** 2026-03-15
**Status:** Draft

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

Invalid values (unknown `status`, `page < 1`, `limit > 50`) return `400 { error: string }`.

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

`urlsBrowserPending` is a derived field (`urlsSpaDetected - urlsBrowserDone`), not a DB column. The route handler computes it when mapping raw `ScrapeJob` rows to `JobStatusDTO` (consistent with the existing `GET /api/scrape/:jobId` pattern).

**Ordering:**
- `status=active` → `ORDER BY createdAt DESC` (uses existing `idx_created_at`)
- `status=done` → `ORDER BY finishedAt DESC` (requires a new `idx_finished_at` index — see DB migration below)

---

### `GET /api/jobs/stats`

Returns the count of currently active jobs.

**Response `200`:**

```json
{ "activeCount": 5 }
```

No caching. Uses indexed `COUNT(*)` on `status` (`idx_status`).

---

## Backend Changes

### DB migration — new index

Add `idx_finished_at` on `scrape_jobs(finished_at)` to support efficient `ORDER BY finishedAt DESC` on the History query.

```sql
CREATE INDEX idx_finished_at ON scrape_jobs(finished_at);
```

Add to Prisma schema:
```prisma
@@index([finishedAt], name: "idx_finished_at")
```

Run `npm run db:migrate -w packages/api` to apply.

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

`findPaginated` fetches raw `ScrapeJob` rows. The route handler derives `urlsBrowserPending = urlsSpaDetected - urlsBrowserDone` when mapping to `JobStatusDTO`.

### `packages/api/src/routes/jobs.ts` (new file)

Fastify route plugin registered at prefix `/api/jobs`:

- `GET /stats` — registered **first** to avoid any future param-route shadowing. Calls `countActive`, returns `{ activeCount }`.
- `GET /` — validates query params (Zod), calls `findPaginated`, maps rows to `JobStatusDTO[]` (computing `urlsBrowserPending = urlsSpaDetected - urlsBrowserDone`), returns pagination envelope.

Registered in `app.ts` alongside `scrape.ts`. No Redis caching on either route.

**Canonical client URLs:** `GET /api/jobs?status=active&page=1` and `GET /api/jobs/stats`.

**No changes** to `scrape.ts` or any worker file.

---

## Frontend Changes

### `packages/web/src/api/client.ts`

Two new methods:

```typescript
getJobs(status: 'active' | 'done', page: number, limit?: number): Promise<JobListResponse>
getJobStats(): Promise<{ activeCount: number }>
```

Add to `packages/web/src/types.ts`:

```typescript
export type JobListResponse = {
  data: JobStatus[]
  pagination: Pagination   // existing Pagination type
}
```

`limit` defaults to `20` on the server when omitted. Both tabs use the default of 20 items per page.

### New hooks

**`useJobs(status, page, options?)`** (`packages/web/src/hooks/useJobs.ts`)

Signature:
```typescript
function useJobs(
  status: 'active' | 'done',
  page: number,
  options?: { enabled?: boolean }
)
```

- Wraps `api.getJobs()` via TanStack Query.
- Key: `['jobList', status, page]`
- When `status === 'active'`: `refetchInterval: 3000`, `retry: false`.
- When `status === 'done'`: no `refetchInterval`, `staleTime: Infinity` (fetches once per page; re-fetches only when page changes). `retry: false`.
- `enabled` defaults to `true`; callers can pass `enabled: false` to defer fetching (used by the History tab lazy-load gate).
- If a fetch fails, polling continues on the next interval. Show stale data with a subtle error indicator if available; show a generic error message if no data has ever loaded.
- **Transition detection (active status only):** Uses a `useRef<Map<string, JobStatus>>` to store the previous job-id → status snapshot. Inside a `useEffect` watching `data`, for each job in the previous snapshot that is no longer present in the new `data.data` array, assume it completed and:
  - Call `queryClient.invalidateQueries({ queryKey: ['media'] })`.
  - Fire `toast.success('Job completed')` (generic — the final `done`/`failed` status is not available from the active list response; the user can check History for the true outcome).
  - Update the ref to the new snapshot after comparison.
- Transition detection runs only when `status === 'active'`.
- This fires per-page — jobs completing on unviewed pages will not trigger toasts or media invalidation until those pages are polled. This is a known limitation (see below).

**`useJobStats()`** (`packages/web/src/hooks/useJobStats.ts`)

- Wraps `api.getJobStats()` via TanStack Query.
- Key: `['jobStats']`
- `refetchInterval: 3000`, `retry: false`.
- Drives the red badge on the Activity button.

### TanStack Query key namespacing

| Hook | Query key |
|------|-----------|
| `useJobs` | `['jobList', status, page]` |
| `useJobStats` | `['jobStats']` |
| `useMedia` | `['media', ...filters]` |

`jobList` and `jobStats` are distinct top-level keys — a broad `invalidateQueries({ queryKey: ['jobList'] })` will not affect stats, and vice versa.

### Deprecated / removed

- `useActiveJobs` — removed entirely. No more local job ID tracking.
- `useJobStatus(jobId)` — **retained for `ScrapeModal` only.** `ScrapeModal` uses `useJobStatus` internally to display live progress of the just-submitted job inside the modal. Do not delete the hook; remove it only from `JobsDrawer` and `HomePage`. The individual-polling cost is acceptable for a single job inside an open modal.

### `packages/web/src/components/JobsDrawer.tsx`

**Props interface after refactor:**

```typescript
interface JobsDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}
```

`trackedJobs` and `onRemoveJob` props are removed.

**Structural changes:**

- Add two tabs: **Active** (default) / **History**.
- Active tab:
  - Renders jobs from `useJobs('active', page)`, polls every 3s.
  - Shows progress bar + status badge per job (same as current).
  - Empty state: "No active jobs" (same icon as current empty state).
  - Pagination controls at bottom (previous / next, current page / total pages).
- History tab:
  - Uses `useJobs('done', page, { enabled: historyTabEverOpened })` where `historyTabEverOpened` is a `useState(false)` flag in `JobsDrawer`, set to `true` the first time the History tab is clicked. This means the query fires once on first open and then re-fetches only when the page changes.
  - Shows finished jobs with `finishedAt` timestamp.
  - Pagination controls at bottom.
  - **Known limitation:** History tab does not auto-refresh when new jobs complete. User must paginate or re-open the drawer to see newly finished jobs.
- Remove per-job dismiss (X button) and "Clear All" button — no longer needed.

### Activity button badge

- Reads `useJobStats().data?.activeCount ?? 0`.
- Shown only when `activeCount > 0`.
- Updates every ~3s via the stats hook polling.
- The badge count and Active tab list may diverge briefly (eventual consistency between two independent polls) — this is expected.

### `packages/web/src/pages/HomePage.tsx`

- Remove `useActiveJobs` usage.
- Remove passing `trackedJobs` and `onRemoveJob` to `JobsDrawer`.
- `ScrapeModal`: remove `onJobStarted` prop entirely — the new job appears in the Active tab on next poll (within 3s). `ScrapeModal` interface no longer includes any post-submit job tracking callback.

---

## Data Flow

```
[Activity button]
  └── useJobStats() polls /api/jobs/stats every 3s → badge count

[JobsDrawer — Active tab]
  └── useJobs('active', page) polls /api/jobs?status=active every 3s
        └── useEffect: compare prev snapshot → detect completions
              ├── invalidate ['media'] query
              └── fire toast per completed/failed job

[JobsDrawer — History tab] (lazy — only when first opened)
  └── useJobs('done', page) fetches /api/jobs?status=done
        once on first open, then once per page change
```

---

## Known Limitations

- **Cross-page completion detection:** Media invalidation and toasts only fire for jobs completing on the currently viewed page of the Active tab. Jobs completing on other pages will be caught when the user navigates to those pages, or when the media list is next refreshed manually.
- **History tab staleness:** History does not auto-refresh. Newly completed jobs appear only after the user paginates or re-opens the drawer.
- **Badge / list divergence:** The activity badge and the Active tab list are polled independently; they may show different counts for up to ~3s.

---

## Out of Scope

- WebSocket / SSE real-time updates (polling is sufficient).
- Per-job URL error breakdown in the drawer.
- Job cancellation.
- Auth / per-user job isolation (no auth in this project).
