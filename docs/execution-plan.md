# Media Scraper — Execution Plan

> Reference: technical-design.md
> Last updated: 2026-03-14 (rev 2 — SPA handling added)

---

## Overview

The project is split into 6 milestones executed sequentially, with clear done criteria per milestone. Each milestone produces working, testable code.

```
Milestone 1: Project foundation & infrastructure
Milestone 2: Core scraping engine (performance-critical)
Milestone 3: API layer (Fastify + BullMQ integration)
Milestone 4: Database layer (Prisma + MySQL)
Milestone 5: React frontend (gallery + job tracker)
Milestone 6: Load testing & production hardening
```

Estimated scope per milestone: 1–2 days of focused engineering.

---

## Milestone 1 — Project Foundation & Infrastructure

**Goal:** Repo structure, tooling, Docker Compose, environment validation. Zero business logic yet.

### Tasks

- [ ] Initialize monorepo with `packages/api` and `packages/web`
- [ ] Configure TypeScript (`strict: true`) for both packages
- [ ] Configure ESLint + Prettier (enforced, no warnings)
- [ ] Set up Fastify skeleton with health check route (`GET /healthz`)
- [ ] Set up Vite + React skeleton
- [ ] Write `docker-compose.yml`:
  - `mysql:8` service with tuned config (`innodb_buffer_pool_size=256M`)
  - `redis:7-alpine` service
  - `api` service with ulimits and NODE_OPTIONS
  - `web` service (nginx serving built React)
- [ ] Write `.env.example` and validate all env vars with zod at startup
- [ ] Set up Prisma with MySQL connection, initial `prisma migrate dev`
- [ ] Create all 4 tables per schema in `technical-design.md`
- [ ] Verify: `docker compose up` → all services healthy

### Done Criteria
- `docker compose up` starts all services cleanly
- `GET /healthz` returns 200
- Prisma migrations run successfully on MySQL
- TypeScript compiles with zero errors

---

## Milestone 2 — Core Scraping Engine

**Goal:** The performance-critical scraping pipeline. This is the hardest and most important milestone.

### Tasks

#### HTTP Client (`src/scraper/http-client.ts`)
- [ ] Configure `undici.Agent`:
  - `connections: 10` per origin
  - `headersTimeout: 10_000`
  - `bodyTimeout: 30_000`
  - `connectTimeout: 5_000`
- [ ] Implement DNS cache (custom resolver with 5-min TTL Map)
- [ ] Export singleton agent

#### HTTP Client (`src/scraper/http-client.ts`) — additions
- [ ] Export `globalLimit = pLimit(SCRAPER_CONCURRENCY)` as process-level singleton alongside the undici Agent
- [ ] Add `MAX_BODY_BYTES = 5 * 1024 * 1024` constant

#### HTML Parser (`src/scraper/parser.ts`)
- [ ] Implement SAX streaming parser using `htmlparser2` WritableStream
- [ ] Extract: `<img src alt>`, `<video src>`, `<source src>`
- [ ] Extract: `<title>` text, `<meta name="description" content>`
- [ ] Collect SPA signals during the same parse pass (zero extra cost):
  - `hasRootDiv`: `<div id="root|app|__next|__nuxt">`
  - `hasNextData` / `hasNuxtData`: inline script content check
  - `hasNoScriptWarning`: `<noscript>` text containing "javascript"
  - `bodyTextLength`: visible character count (strip tags)
  - `scriptTagCount` and `mediaCount`
- [ ] Normalize relative URLs to absolute using base URL
- [ ] Filter out data URIs and blank src attributes
- [ ] Return typed `ParsedPage` interface (includes `SpaSignals`)

#### SPA Detector (`src/scraper/spa-detector.ts`)
- [ ] Implement `scoreSpa(signals: SpaSignals): number` — pure function, easily testable
- [ ] Implement `isSpa(signals: SpaSignals, mediaCount: number): boolean` — threshold 6
- [ ] Key rule: if `mediaCount > 0`, return `false` regardless of score (SSR sites served content)
- [ ] Export `SPA_SCORE_THRESHOLD` constant (default: 6)

#### Response Size Guard (`src/scraper/http-client.ts`)
- [ ] Check `Content-Length` header before reading body — if > 5 MB: `body.dump()`, return `{ error: 'response_too_large' }`
- [ ] Insert `Transform` stream as byte counter in SAX pipeline — abort if bytes exceed 5 MB mid-stream
- [ ] Use `stream/promises.pipeline()` to chain: `body → sizeGuard → saxParser`

#### Retry Logic (`src/scraper/retry.ts`)
- [ ] Exponential backoff with ±30% jitter
- [ ] Max 3 retries
- [ ] Retryable codes: `ECONNRESET`, `ETIMEDOUT`, `ECONNREFUSED`, `UND_ERR_SOCKET`
- [ ] Retryable HTTP: 429 (with Retry-After), 500, 502, 503, 504
- [ ] Non-retryable: 404, 403, 401, 400, TLS errors
- [ ] `body.dump()` on all non-success responses (critical for socket pool)

#### Circuit Breaker (`src/scraper/circuit-breaker.ts`)
- [ ] Per-domain state tracking
- [ ] Trip at 10 failures within window
- [ ] Reset after 60s
- [ ] Singleton, shared across all concurrent requests

#### Fast Processor (`src/worker/fast.processor.ts`)
- [ ] Accept `{ jobId, browserFallback, maxScrollDepth, urls: Array<{id, url}> }` payload (IDs fetched at enqueue time)
- [ ] Import and use `globalLimit` from `http-client.ts` — never create a new `pLimit()` instance
- [ ] `Promise.allSettled` (never `Promise.all`)
- [ ] Per URL after parse:
  - Run `isSpa(signals, mediaCount)`
  - If SPA and `browserFallback=true`: update `scrape_requests.status = 'spa_detected'`, enqueue to `scrape:browser` at priority 10
  - If SPA and `browserFallback=false`: update status to `'failed'`, error `"spa_detected"`, increment `urls_done`
  - If not SPA: write media to DB via batch buffer, increment `urls_done`, update `scrape_requests` row by ID
- [ ] Batch buffer: flush at 500 items OR every 5 seconds
- [ ] Atomically increment `urls_spa_detected` for each SPA URL detected
- [ ] When fast BullMQ job finishes: atomic SQL sets `status = 'fast_complete'` (SPAs pending) or `'done'` (no SPAs)
- [ ] Media lost if process crashes before batch flush — this is acceptable (documented decision)

#### Browser Processor (`src/worker/browser.processor.ts`)
- [ ] Import Playwright `chromium` from `playwright-core`
- [ ] Use `PlaywrightSingleton` — one browser shared for the worker's lifetime
- [ ] Per URL:
  - `const page = await browser.newPage()`
  - Block: `stylesheet`, `font`, `image` resource types
  - `page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })` — NOT networkidle
  - `page.waitForTimeout(1_000)` — let React/Vue register intersection observers
  - `autoScroll(page, { steps: maxScrollDepth, stepPx: 400, delayMs: 200 })`
  - `page.$$eval('img, video, source', ...)` — extract `src || data-src || data-lazy || data-original`, skip data: URIs
  - `await page.close()` — ALWAYS in finally block, even on error
  - Write to DB via same batch buffer / repository as fast path
  - After each URL: atomic SQL increments `urls_browser_done` and transitions to `'done'` if all SPAs complete

#### Playwright Singleton (`src/worker/playwright.singleton.ts`)
- [ ] Launch browser once on module init
- [ ] Export `getBrowser(): Promise<Browser>`
- [ ] Handle browser crash: relaunch on `browser.on('disconnected')`
- [ ] On process SIGTERM/SIGINT: `await browser.close()`

### Unit Tests
- [ ] Parser: extracts correct media from 5 representative HTML fixture files
- [ ] SPA detector: scores correctly for known SPA patterns; returns false when mediaCount > 0
- [ ] Retry: correctly retries on ECONNRESET, stops on 404
- [ ] Circuit breaker: opens after 10 failures, resets after timeout
- [ ] Fast processor: re-queues SPA URL when browserFallback=true; marks failed when false

### Done Criteria
- Parser correctly extracts images and videos from static HTML fixtures
- SPA detector: correctly classifies 5 SPA fixtures and 5 static fixtures
- `isSpa` returns `false` when media was found (even on SPA-looking page = SSR)
- Retry logic test passes for all retryable/non-retryable codes
- Unit test coverage ≥ 80% for scraping engine and SPA detector

---

## Milestone 3 — API Layer

**Goal:** Fastify routes + BullMQ integration. Async job pattern.

### Tasks

#### BullMQ Setup (`src/worker/`)
- [ ] Create two BullMQ Queues:
  - `scrape:fast` — default priority 1
  - `scrape:browser` — default priority 10 (higher number = lower priority in BullMQ)
- [ ] `FastScrapeWorker`: `concurrency: 2` (2 batch-jobs in parallel; p-limit(70) handles per-URL concurrency within each)
- [ ] `BrowserScrapeWorker`: `concurrency: 1` (hard cap — only 1 Playwright page at a time)
- [ ] Fast job payload: `{ jobId: string, urls: string[], browserFallback: boolean }`
- [ ] Browser job payload: `{ jobId: string, url: string }` (single URL per job)
- [ ] On fast job start: update `scrape_jobs.status = 'running'`
- [ ] On fast job complete: check if all URLs done → if yes, update status to 'done'
- [ ] On browser job complete: increment `urls_browser_done`; check if job fully complete
- [ ] BullMQ job retries: 0 for both (retry logic is internal to processors)

#### Routes (`src/routes/`)

`POST /api/scrape`:
- [ ] Register `@fastify/rate-limit` with Redis backend; read `RATE_LIMIT_MAX` + `RATE_LIMIT_WINDOW` from env via zod config
- [ ] Check BullMQ queue depth against `QUEUE_MAX_DEPTH` env var; return 503 if exceeded
- [ ] Validate body with Fastify JSON schema:
  - `urls`: array, 1–5000 items, each string must be a valid URL
  - `options.browserFallback`: boolean, default `false`
  - `options.maxScrollDepth`: integer, 1–60, default `10`
- [ ] Create `scrape_jobs` row (include `browser_fallback`, `max_scroll_depth`)
- [ ] Bulk insert all URLs into `scrape_requests` (status: 'pending'), then fetch inserted IDs
- [ ] Enqueue single BullMQ job to `scrape:fast` with `{ jobId, browserFallback, maxScrollDepth, urls: [{id, url}] }`
- [ ] Return 202 `{ jobId }`

`GET /api/scrape/:jobId`:
- [ ] Fetch from `scrape_jobs` by id
- [ ] Cache in Redis for 2s (reduces DB reads under heavy polling from 5000 clients)
- [ ] Return full status DTO including `status` (pending|running|fast_complete|done|failed), `urlsSpaDetected`, `urlsBrowserDone`, `urlsBrowserPending`

`GET /api/media`:
- [ ] Parse and validate query params (page, limit, type, search, jobId)
- [ ] Build Prisma query with filters
- [ ] FULLTEXT search via raw query for `search` param
- [ ] Return paginated response

`GET /api/media/:id`:
- [ ] Fetch single media item with page join (for title/description)
- [ ] 404 if not found

### Integration Tests
- [ ] POST /api/scrape enqueues job and returns jobId
- [ ] GET /api/scrape/:id returns correct status
- [ ] GET /api/media pagination and type filter work correctly
- [ ] GET /api/media search returns relevant results

### Done Criteria
- All 4 routes respond correctly via `curl` or Postman
- BullMQ job is enqueued and processed end-to-end (POST → scrape → DB insert)
- Integration tests pass against local MySQL + Redis

---

## Milestone 4 — Database Layer

**Goal:** Repositories, Prisma schema finalized, batch insert optimized.

### Tasks

- [ ] Finalize `prisma/schema.prisma` with all 4 models
- [ ] Write `JobRepository`:
  - `create(id, urlsTotal)`
  - `updateStatus(id, status, finishedAt?)`
  - `incrementUrlsDone(id, count)` — uses `UPDATE ... SET urls_done = urls_done + ?` (atomic)
  - `findById(id)`
- [ ] Write `MediaRepository`:
  - `upsertBatch(items[])` — single `INSERT ... ON DUPLICATE KEY UPDATE` for 500 items
  - `findPaginated(filters)` — handles type, search, jobId, pagination
- [ ] Verify: upsert correctly deduplicates on `media_url_hash`
- [ ] Verify: `incrementUrlsDone` is safe under concurrent updates
- [ ] Add DB indexes as per schema (verify with `EXPLAIN SELECT`)

### Done Criteria
- Batch upsert of 500 items completes in < 500ms on local MySQL
- `EXPLAIN SELECT` on media list query shows index usage (no full table scan)
- Deduplication: inserting same media_url twice results in 1 row

---

## Milestone 5 — React Frontend

**Goal:** Media gallery with grid view, job submission, status polling, filters, search, pagination.

### Tasks

#### Pages

`HomePage`:
- [ ] URL input (textarea — one URL per line)
- [ ] Submit button → POST /api/scrape → store jobId in state
- [ ] Show `JobStatus` component while job is running
- [ ] Navigate to GalleryPage on completion

`GalleryPage`:
- [ ] Filter bar: type (All / Images / Videos), text search input
- [ ] `MediaGrid` — responsive CSS grid, 3–4 columns
- [ ] `MediaCard` — shows image preview or video thumbnail, source URL, alt text
- [ ] Pagination controls
- [ ] Loading skeleton state
- [ ] Empty state

#### Hooks

`useJobStatus(jobId)`:
- [ ] TanStack Query with polling every 2s while status is `pending` or `running`
- [ ] Stop polling when `done` or `failed`

`useMedia(filters)`:
- [ ] TanStack Query with pagination
- [ ] Debounce search input 300ms
- [ ] Prefetch next page

#### Done Criteria
- Can submit 10 URLs, watch job progress, see results in gallery
- Type filter works (images vs videos)
- Search filters results in real-time (debounced)
- Pagination navigates between pages of results
- Video cards show `<video>` tag with controls; image cards show `<img>`
- Responsive: looks good at 1280px and 768px

---

## Milestone 6 — Load Testing & Production Hardening

**Goal:** Verify 5000 concurrent API clients; harden for production.

### Tasks

#### Load Test (`load-test/k6-scrape.js`)
- [ ] Scenario: ramp 0 → 5000 VUs over 30s, hold for 60s
- [ ] Each VU: POST /api/scrape with 5 **static HTML** URLs, `browserFallback: false`
- [ ] Thresholds:
  - POST p95 < 500ms under 5000 concurrent clients
  - Error rate < 0.5%
  - All jobs reach terminal status within 120s
- [ ] Monitor `docker stats` during test (log peak RAM)
- [ ] Separate SPA smoke test (manual, not in k6):
  - Submit 3 known SPA URLs with `browserFallback: true`
  - Assert `urlsSpaDetected: 3` in job status response
  - Assert browser worker completes all 3 sequentially
  - Assert media items appear in gallery

#### Production Hardening
- [ ] Add request ID header to all responses (for tracing)
- [ ] Structured JSON logging (pino — built into Fastify)
- [ ] Log memory usage every 30s in both fast worker and browser worker
- [ ] Graceful shutdown sequence:
  1. Stop accepting new BullMQ jobs (`worker.pause()`)
  2. Wait for in-flight fast-path jobs to complete
  3. `await browser.close()` (Playwright singleton)
  4. Close undici agent
  5. Close DB connection
- [ ] Docker health checks for all services
- [ ] `docker-compose.prod.yml` with resource limits:
  ```yaml
  mem_limit: 580m
  cpus: 1.0
  ulimits:
    nofile: { soft: 65536, hard: 65536 }
  ```
- [ ] README with setup instructions and load test run command

### Done Criteria
- k6 load test passes all thresholds
- No OOM crashes during load test
- Peak RAM stays under 580 MB for the Node container
- Graceful shutdown completes within 10s (no job corruption)
- `docker compose up` on a fresh machine works end-to-end

---

## Task Breakdown Summary

| Milestone | Key Deliverables | Risk Level |
|-----------|-----------------|-----------|
| 1 — Foundation | Repo, Docker, DB schema, TypeScript setup | Low |
| 2 — Scraper Engine | undici + htmlparser2 + p-limit + circuit breaker | **High** (performance-critical) |
| 3 — API Layer | Fastify routes, BullMQ integration, async job flow | Medium |
| 4 — DB Layer | Prisma, repositories, batch upsert, indexes | Medium |
| 5 — Frontend | React gallery, job polling, filters, pagination | Low–Medium |
| 6 — Load Test | k6 script, production hardening, Docker tuning | Medium |

---

## Parallel Work Opportunities

When using AI agents in parallel, these tasks are independent:

```
Milestone 2 (scraper engine) can be developed in parallel with:
  └── Milestone 4 (DB repositories) — no dependency between them

Milestone 5 (frontend) can start as soon as Milestone 3 API routes are defined:
  └── Frontend can mock API responses while backend is finalized
```

---

## Performance Targets

| Metric | Target | Notes |
|--------|--------|-------|
| POST /api/scrape p95 | < 500ms under 5000 concurrent | Fastify + BullMQ enqueue only |
| Scraping throughput | 100–250 req/s | p-limit(100), avg 500ms latency |
| 5000 URL job | 25–50 seconds | Depends on target server latency |
| Peak Node.js RAM | < 550 MB | With heap cap at 500 MB |
| DB batch write (500 rows) | < 500ms | With DUPLICATE KEY UPDATE |
| Media list query p95 | < 100ms | With proper indexes |
