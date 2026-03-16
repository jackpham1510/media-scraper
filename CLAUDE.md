# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Commands

All commands are run from the monorepo root unless noted.

### Backend (`packages/api`)
```bash
# Development
npm run dev -w packages/api          # Fastify + BullMQ workers with tsx watch

# Build & type check
npm run build -w packages/api        # compile TypeScript to dist/
npm run typecheck -w packages/api    # tsc --noEmit

# Tests
npm run test -w packages/api         # run all tests (jest --runInBand)
npm run test -w packages/api -- --testPathPattern=spa-detector   # single test file

# Database
npm run db:migrate -w packages/api   # prisma migrate dev
npm run db:generate -w packages/api  # prisma generate (after schema changes)
npm run db:studio -w packages/api    # prisma studio (DB GUI)
```

### Frontend (`packages/web`)
```bash
npm run dev -w packages/web          # Vite dev server (port 5173, proxies /api → :3001)
npm run build -w packages/web        # tsc + vite build
npm run typecheck -w packages/web    # tsc --noEmit
```

### Docker (full stack)
```bash
docker compose up                    # start all services (MySQL, Redis, api, web)
docker compose up --build            # rebuild images first
docker stats                         # monitor RAM — critical on 1 CPU / 1 GB target
```

### Load test
```bash
k6 run load-test/k6-scrape.js                                    # default: wiki-100.csv, 500 VUs
k6 run load-test/k6-scrape.js -e CSV_FILE=./js-packages-100.csv  # custom CSV
k6 run load-test/k6-scrape.js -e MAX_VUS=200                     # custom VU count
```

---

## Architecture

### Monorepo Layout
```
packages/api/    — Fastify 5 API + BullMQ 5 workers (monolith, TypeScript strict)
packages/web/    — Vite 6 + React 19 frontend (TypeScript strict)
load-test/       — k6 load test scripts + CSV URL lists
docs/            — technical-design.md, execution-plan.md, guardrails.md
```

### Backend (`packages/api/src/`)
```
main.ts          — entry point: server setup, route registration, graceful shutdown
config/
  env.ts           zod-validated env vars (DATABASE_URL, REDIS_URL, PORT, SCRAPER_CONCURRENCY, QUEUE_MAX_DEPTH)
routes/
  health.ts        GET /healthz
  scrape.ts        POST /api/scrape, GET /api/scrape/:jobId
  jobs.ts          GET /api/jobs?status=active|done
  media.ts         GET /api/media, GET /api/media/:id
worker/
  index.ts           queue/worker creation (scrape-fast, scrape-browser)
  fast.processor.ts  FastScrapeWorker (concurrency: 2, chunk-based, uses globalLimit)
  browser.processor.ts  BrowserScrapeWorker (concurrency: 1 HARD CAP)
  playwright.singleton.ts  lazy singleton Chromium instance
scraper/
  http-client.ts    undici Agent singleton + globalLimit (p-limit) + fetchUrl()
  parser.ts         htmlparser2 SAX streaming (media + SPA signals in single pass)
  spa-detector.ts   score-based SPA heuristic (pure function)
  retry.ts          exponential backoff with jitter
db/
  index.ts           Prisma client singleton
  repositories/
    job.repository.ts      scrape_jobs CRUD + atomic status transitions
    request.repository.ts  scrape_requests bulk insert + status updates
    page.repository.ts     scrape_pages upsert (INSERT IGNORE + SELECT)
    media.repository.ts    media_items bulk upsert + paginated queries
types/
  index.ts           shared interfaces (JobStatus, UrlStatus, FastJobPayload, BrowserJobPayload, etc.)
```

### Frontend (`packages/web/src/`)
```
main.tsx           — React root
App.tsx            — QueryClient (TanStack Query v5) + Toaster (sonner)
pages/
  HomePage.tsx       main page: filters, media grid, pagination, modals
components/
  ScrapeModal.tsx    URL input form → progress tracking → result
  JobsDrawer.tsx     side drawer with Active/History tabs
  MediaGrid.tsx      responsive grid with skeleton loading
  MediaCard.tsx      img/video card with lazy loading
  MediaLightbox.tsx  full-screen overlay with keyboard nav
  ui/                shadcn/ui primitives (button, dialog, sheet, etc.)
hooks/
  useMedia.ts        paginated media query with debounced search
  useJobStatus.ts    2s polling while job is active
  useJobs.ts         Active (3s poll) / History tabs with toast notifications
api/
  client.ts          fetch-based API client (scrape, getJobStatus, getJobs, getMedia)
types.ts             frontend type definitions
```

### Two-Queue Architecture
- **`scrape-fast`** (priority 1) — undici + htmlparser2 SAX, global `p-limit(70)` singleton. All jobs land here first. Processes URLs in chunks of 100.
- **`scrape-browser`** (priority 10 = lowest) — Playwright, concurrency: 1. Only receives URLs detected as SPAs when `browserFallback: true`.

BullMQ processes fast before browser, so peaks don't overlap.

**Critical:** `p-limit(70)` is a **process-level singleton** exported from `http-client.ts`. `FastScrapeWorker` runs with `concurrency: 2` — without a shared limiter those two jobs would each create `p-limit(70)` = 140 concurrent requests. Always import `globalLimit`, never call `pLimit()` in processors.

### Job Status Machine
```
pending → running → fast_complete → done
                  ↘               ↗
                   done (no SPAs)
```
Status transitions happen inside atomic SQL `UPDATE ... SET status = CASE ... END WHERE ...` — no separate SELECT, no race conditions.

### SPA Detection Flow
During the SAX parse pass, signals are collected at zero extra cost:
1. `parser.ts` collects `SpaSignals` (root div id, script count, body text length, noscript content, `__NEXT_DATA__`/`__NUXT__` markers)
2. `spa-detector.ts` scores signals (threshold ≥ 6)
3. **Key rule:** `isSpa()` returns `false` whenever `mediaCount > 0` — if we found media, it's SSR, don't re-queue

### Memory Budget (1 CPU / 1 GB RAM target)
```
OS:         ~100 MB
MySQL:      ~256 MB  (innodb_buffer_pool_size=256M — do not change)
Redis:       ~40 MB
Node.js:    ~480 MB  (--max-old-space-size=480 --max-semi-space-size=64)
Playwright: ~300 MB  (only while browser queue has work — does not overlap with fast peak)
```

---

## Critical Rules (see `docs/guardrails.md` for full detail)

### Concurrency — violations cause OOM crashes
- `globalLimit` from `http-client.ts` wraps **all** scraping HTTP requests. Never call `pLimit()` in processors.
- Always `Promise.allSettled`, never `Promise.all` for batch operations.
- Always `body.dump()` on non-200 responses — sockets won't return to pool otherwise.
- Always apply 5 MB response size cap: Content-Length header check + streaming byte-counter Transform.
- htmlparser2 SAX runs on the **main thread** — callbacks are µs, no worker threads needed.
- Batch DB writes: 500 rows per INSERT, never one-by-one.

### HTTP Client
- Use `undici` for all server-side HTTP. Not axios. Not fetch.
- The `undici.Agent` singleton and `globalLimit` both live in `http-client.ts` — import them, don't create new instances.
- Every request must have `headersTimeout` and `bodyTimeout` set.

### Playwright (browser worker)
- `browser.close()` only in SIGTERM/SIGINT shutdown handler — never in the hot path.
- `page.close()` in a `finally` block after every URL — always.
- Never `waitUntil: 'networkidle'` — use `domcontentloaded` + `waitForTimeout(1000)` + `autoScroll()`.
- Extract `data-src`, `data-lazy`, `data-original` alongside `src` for lazy-loaded media.
- Block `stylesheet`, `font`, `image` resource types — we read `src` attributes from DOM, not bytes.
- `BrowserScrapeWorker` concurrency stays at 1. No room for 2 Chromium tabs.
- `playwright` imported only in `browser.processor.ts` and `playwright.singleton.ts`.

### Database
- All DB access goes through `db/repositories/`. No Prisma calls in routes or workers directly.
- **Prefer Prisma client methods** (`findMany`, `create`, `update`, `count`, `increment`, etc.) for standard CRUD. Only use raw queries (`$executeRawUnsafe` / `$queryRawUnsafe`) when the query cannot be expressed with Prisma — e.g., atomic `CASE` expressions referencing current column values, bulk `INSERT ... ON DUPLICATE KEY UPDATE`, `INSERT IGNORE`, or `LAST_INSERT_ID()` in transactions. Raw queries must have a comment explaining why.
- Media dedup: `INSERT ... ON DUPLICATE KEY UPDATE` on `media_url_hash` (SHA-256).
- Job status transitions: atomic single-statement `UPDATE ... CASE ... WHERE ...` — never SELECT then UPDATE.
- `scrape_request` rows updated by primary key (ID in BullMQ payload) — never scan by `url TEXT`.

### TypeScript
- `strict: true`. No `any`. Use `unknown` + type narrowing.
- Route handlers are thin — validate → enqueue/query → respond. Business logic in `scraper/` or `db/repositories/`.
- Shared types go in `src/types/` — do not redefine the same shape in multiple files.

### Error Handling
- Catch errors at the boundary where recovery is possible — don't swallow silently.
- BullMQ processors must update job status to `'failed'` before rethrowing.
- HTTP routes return `{ error: string }` — never expose stack traces.
- Failed scrape URLs must be logged as structured JSON.

---

## API Contract

```
POST /api/scrape
  Body: { urls: string[], options?: { browserFallback?: boolean, maxScrollDepth?: 1-60 } }
  → 202 { jobId: string }

GET /api/scrape/:jobId
  → { jobId, status, urlsTotal, urlsDone, urlsSpaDetected, urlsBrowserDone, urlsBrowserPending, createdAt, finishedAt }
  (2s Redis cache)

GET /api/jobs?status=active|done&page=1&limit=20
  → { data: JobStatus[], pagination: { page, limit, total, totalPages } }

GET /api/media?page=1&limit=20&type=image|video&search=query&jobId=uuid
  → { data: MediaItem[], pagination: { page, limit, total, totalPages } }

GET /api/media/:id
  → MediaItem

GET /healthz
  → { status: 'ok' }
```

Full schema and architectural decisions in `docs/technical-design.md`.

---

## Graceful Shutdown (main.ts)

1. Close HTTP server (stop accepting requests)
2. Pause + close BullMQ workers (wait for in-flight jobs)
3. Close Playwright browser (if launched)
4. Close undici HTTP agent
5. Disconnect Redis
6. Disconnect Prisma
