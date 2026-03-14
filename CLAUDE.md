# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Project Status

**Pre-implementation.** The full technical design is finalized in `docs/technical-design.md`. The execution plan with milestones and done criteria is in `docs/execution-plan.md`. Read both before touching any code.

---

## Commands

All commands are run from the monorepo root unless noted.

### Backend (`packages/api`)
```bash
# Development
npm run dev -w packages/api          # start Fastify + BullMQ workers with ts-node watch

# Build
npm run build -w packages/api        # compile TypeScript to dist/

# Tests
npm run test -w packages/api         # run all tests
npm run test -w packages/api -- --testPathPattern=spa-detector   # run single test file

# Database
npm run db:migrate -w packages/api   # prisma migrate dev
npm run db:generate -w packages/api  # prisma generate (after schema changes)
npm run db:studio -w packages/api    # prisma studio (DB GUI)

# Type check
npm run typecheck -w packages/api    # tsc --noEmit
```

### Frontend (`packages/web`)
```bash
npm run dev -w packages/web          # Vite dev server
npm run build -w packages/web        # production build
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
k6 run load-test/k6-scrape.js       # requires k6 installed; target must be running
```

---

## Architecture

### Monorepo Layout
```
packages/api/    — Fastify API + BullMQ workers (monolith, TypeScript strict)
packages/web/    — Vite + React 19 frontend (TypeScript strict)
load-test/       — k6 load test scripts
docs/            — technical design, execution plan, guardrails, research
```

### Backend Internal Structure (`packages/api/src/`)
```
routes/          — Fastify route plugins (thin: validate → enqueue/query → respond)
worker/          — BullMQ workers and Playwright singleton
  fast.worker.ts           FastScrapeWorker (concurrency: 2, uses p-limit internally)
  browser.worker.ts        BrowserScrapeWorker (concurrency: 1 HARD CAP)
  playwright.singleton.ts  single Chromium instance for the process lifetime
scraper/         — pure scraping logic (no framework dependencies)
  http-client.ts    undici Agent singleton
  parser.ts         htmlparser2 SAX streaming (also collects SPA signals)
  spa-detector.ts   score-based SPA heuristic (pure function)
  retry.ts          exponential backoff
  circuit-breaker.ts  per-domain failure tracking
db/
  prisma/schema.prisma
  repositories/    — all DB access goes through here; no ad-hoc Prisma calls in routes
config/          — zod-validated env vars; process exits on missing required vars
types/           — shared TypeScript interfaces
```

### Two-Queue Architecture
The scraping pipeline uses two BullMQ queues with different priorities:

- **`scrape:fast`** (priority 1) — undici + htmlparser2 SAX, global `p-limit(70)` singleton. Handles ~80% of URLs. All jobs land here first.
- **`scrape:browser`** (priority 10 = lowest) — Playwright, concurrency: 1, sequential. Only receives URLs detected as SPAs when caller opted in with `browserFallback: true`.

BullMQ processes `scrape:fast` before `scrape:browser`, so the browser worker only runs when the fast queue is empty. This prevents RAM peaks from overlapping.

**Critical:** `p-limit(70)` is a **process-level singleton** exported from `http-client.ts`. `FastScrapeWorker` runs with `concurrency: 2` (two BullMQ jobs in parallel) — without a shared limiter those two jobs would each create their own `p-limit(70)` = 140 concurrent requests. Always import `globalLimit`, never call `pLimit()` in processors.

### Job Status Machine
```
pending → running → fast_complete → done
                  ↘               ↗
                   done (no SPAs)
```
`fast_complete`: fast queue finished but browser queue still has pending URLs. Job status transitions happen inside atomic SQL `UPDATE ... SET status = CASE ... END WHERE ...` — no separate SELECT, no race conditions.

### SPA Detection Flow
During the SAX parse pass, signals are collected at zero extra cost:
1. `parser.ts` collects `SpaSignals` (root div id, script count, body text length, noscript content, inline `__NEXT_DATA__`/`__NUXT__` markers)
2. After parse, `spa-detector.ts` scores the signals
3. **Key rule:** `isSpa()` returns `false` whenever `mediaCount > 0` — if we found media, it's serving content (SSR), don't re-queue

### Memory Budget (1 CPU / 1 GB RAM target)
```
OS:       ~100 MB
MySQL:    ~256 MB  (innodb_buffer_pool_size=256M — do not change)
Redis:    ~40 MB
Node.js:  ~480 MB  (heap cap via --max-old-space-size=480)
Playwright: ~300 MB (only while browser queue has work — does not overlap with fast peak)
```
Node is launched with: `--max-old-space-size=480 --max-semi-space-size=64`

---

## Critical Rules (read `docs/guardrails.md` for full detail)

### Concurrency — violations cause OOM crashes
- `globalLimit` from `http-client.ts` wraps **all** scraping tasks. Never call `pLimit()` in processors — it's a process singleton shared across all BullMQ jobs.
- Always `Promise.allSettled`, never `Promise.all` for batch operations.
- Always `body.dump()` on non-200 responses — sockets won't return to pool otherwise.
- Always apply 5 MB response size cap: Content-Length header check + streaming byte-counter Transform.
- htmlparser2 SAX runs on the **main thread** — callbacks are µs, no worker threads needed or used.
- DB writes go through the batch buffer (500 rows / 5s flush), never one-by-one.

### HTTP Client
- Use `undici` for all server-side HTTP. Not axios. Not fetch.
- The `undici.Agent` singleton and `globalLimit` both live in `http-client.ts` — import them, don't create new instances.
- Every request must have `headersTimeout` and `bodyTimeout` set.

### Playwright (browser worker)
- `browser.close()` is only called in the SIGTERM/SIGINT shutdown handler — never in the hot path.
- `page.close()` is called in a `finally` block after every URL — always.
- Never use `waitUntil: 'networkidle'` — use `domcontentloaded` + `waitForTimeout(1000)` + `autoScroll()`.
- Extract `data-src`, `data-lazy`, `data-original` alongside `src` — lazy-load libs set these before observer fires.
- Block `stylesheet`, `font`, `image` resource types — we read `src` attributes from DOM, not image bytes.
- `BrowserScrapeWorker` concurrency stays at 1. The 1 GB budget has no room for 2 Chromium tabs.
- `playwright` is imported only in `browser.processor.ts` and `playwright.singleton.ts`.

### Database
- All DB access goes through `db/repositories/`. No Prisma calls in routes or workers directly.
- Upsert pattern: `INSERT ... ON DUPLICATE KEY UPDATE` on `media_url_hash` (SHA-256 of URL).
- Job status transitions use atomic single-statement `UPDATE ... SET status = CASE ... END WHERE ...` — never SELECT then UPDATE.
- `scrape_request` rows are updated by primary key (ID passed in BullMQ job payload) — never scan by `url TEXT`.

### TypeScript
- `strict: true`. No `any`. Use `unknown` + type narrowing.
- Route handlers are thin — business logic belongs in `scraper/` or `db/repositories/`.

---

## API Contract (summary)

```
POST /api/scrape
  Body: { urls: string[], options?: { browserFallback?: boolean } }
  → 202 { jobId: string }

GET /api/scrape/:jobId
  → { status, urlsTotal, urlsDone, urlsSpaDetected, urlsBrowserDone, urlsBrowserPending, ... }

GET /api/media
  → { data: MediaItem[], pagination: { page, limit, total, totalPages } }
  Query: page, limit, type (image|video), search, jobId
```

Full schema, complete API contract, and all architectural decisions are in `docs/technical-design.md`.
