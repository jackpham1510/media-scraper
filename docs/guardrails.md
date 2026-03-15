# Engineering Guardrails

> These rules are mandatory for all AI agents and human contributors working on this codebase.
> When in doubt, ask. Do not guess.

---

## TypeScript

- `strict: true` is non-negotiable. Zero tolerance for `any`.
- All function parameters and return types must be explicitly typed.
- Use `unknown` instead of `any` when the type is genuinely unknown — then narrow it.
- No `@ts-ignore` or `@ts-expect-error` without a comment explaining why and a ticket to fix it.
- Shared types between modules go in `src/types/` — do not redefine the same shape in multiple files.

---

## Concurrency — Performance-Critical Rules

These rules exist because violations cause OOM crashes or throughput collapse on the 1 GB RAM target.

### NEVER do this:
```typescript
// ❌ Opens all sockets simultaneously → OOM
const results = await Promise.all(urls.map(url => fetch(url)));

// ❌ Accumulates all results in RAM → OOM at scale
const allResults = [];
for (const url of urls) {
  allResults.push(await scrape(url));
}
```

### ALWAYS do this:
```typescript
// ✅ Bounded concurrency via GLOBAL singleton limiter
import { globalLimit } from '../scraper/http-client';
const tasks = urls.map(url => globalLimit(() => scrapeOne(url)));
await Promise.allSettled(tasks); // allSettled, not all

// ✅ Stream to DB immediately, don't accumulate
onResult(result => batchBuffer.push(result)); // batch writer flushes at 500
```

### Rules checklist:
- [ ] Every HTTP request has explicit `headersTimeout` and `bodyTimeout`
- [ ] Every non-200 response calls `body.dump()` before returning
- [ ] Every response body is guarded by a 5 MB size limit before/during streaming
- [ ] `Promise.allSettled` is used for all batch operations (never `Promise.all` on unbounded arrays)
- [ ] `globalLimit` (process-level singleton) wraps all scraping tasks — never create a new `pLimit()` per job
- [ ] Results are written to DB via batch buffer — never accumulated in a module-level array
- [ ] htmlparser2 SAX runs on the main thread — no worker threads for parsing

---

## HTTP Client

- Use `undici` for all server-side HTTP requests. Not `axios`. Not `node-fetch`. Not native `fetch` (WebStreams overhead).
- The `undici.Agent` singleton is configured once in `src/scraper/http-client.ts` and imported everywhere. Do not create ad-hoc agents.
- Never make outbound HTTP requests without timeout configuration.

---

## Database

- All DB access goes through the repositories in `src/db/repositories/`. No ad-hoc Prisma calls in routes or workers.
- Raw SQL is only allowed for performance-critical queries (batch upsert, FULLTEXT search) and must be documented with a comment explaining why raw SQL was necessary.
- Never `SELECT *` — always project only the columns you need.
- Migrations are run via `prisma migrate dev` (development) and `prisma migrate deploy` (production). Never modify the DB schema manually.
- Batch inserts: always use `INSERT ... ON DUPLICATE KEY UPDATE` for upserts, never individual inserts in a loop.

---

## Error Handling

- Errors must be caught at the boundary where recovery is possible — not swallowed silently.
- All BullMQ job processors must catch errors and update job status to `'failed'` before rethrowing.
- HTTP route handlers must return structured error responses `{ error: string, code?: string }` — never expose stack traces to clients.
- Use typed error classes (`class ScraperError extends Error`) — never `throw new Error("some string")` in domain code.
- Failed scrape URLs must be logged as structured JSON (not silently dropped).

---

## API Design

- Follow the API contract in `technical-design.md` exactly. Do not add undocumented fields or change response shapes without updating the doc.
- All routes use Fastify JSON Schema for request validation. No manual `if (!body.urls)` checks.
- HTTP status codes: 202 for accepted async jobs, 400 for validation errors, 404 for missing resources, 500 for unhandled server errors. No 200 for errors.
- Pagination: always return `{ data, pagination: { page, limit, total, totalPages } }` — never a plain array.

---

## Code Structure

- Modules are organized by domain (`scraper/`, `worker/`, `db/`, `routes/`), not by type (`services/`, `controllers/`, `models/`).
- Do not add abstraction layers unless they serve more than one consumer. One-time utilities are written inline.
- Route handlers are thin: validate → call repository or enqueue job → return response. Business logic belongs in `scraper/` or `db/repositories/`.
- Environment configuration is validated with `zod` at startup. If a required env var is missing, the process exits immediately with a clear error message.

---

## Testing

- Unit tests for: scraping engine (parser, retry), repositories (batch upsert, pagination).
- Integration tests for: all API routes (POST /scrape, GET /scrape/:id, GET /media).
- Load test: k6 script in `load-test/k6-scrape.js` — must pass before any deployment claim.
- No mocking of the DB in integration tests — use a real MySQL instance (Docker).
- Test files: `*.test.ts` co-located with source, or in `__tests__/` folder.

---

## Docker & Deployment

- The Node container must run with:
  ```
  --max-old-space-size=500
  --max-semi-space-size=64
  UV_THREADPOOL_SIZE=16
  ulimit nofile: 65536
  mem_limit: 580m
  ```
  These are not optional. They prevent OOM on the target machine.

- MySQL must run with `innodb_buffer_pool_size=256M` — the default (128M×5) is too high for 1 GB RAM.
- All services must have health checks in `docker-compose.yml`.
- No secrets in Dockerfiles or committed `.env` files. Use `.env.example` with placeholders.

---

## SPA / Browser Worker Rules

These rules exist to prevent Playwright from OOM-killing the entire service.

- **Never** launch a new `chromium.launch()` per URL. The browser instance is a singleton for the worker process lifetime (`playwright.singleton.ts`). Violating this = 300 MB allocation per URL.
- **Always** call `page.close()` after each URL — in a `finally` block. This is the only way to release Chromium tab memory.
- **Never** call `browser.close()` in the hot path. Only call it during graceful shutdown (SIGTERM/SIGINT handler).
- **Always** block `stylesheet`, `font`, and `image` resource types in Playwright requests. We extract image/video URLs from the DOM — we do not need to load the actual images.
- **Never** increase `BrowserScrapeWorker` concurrency above 1. The memory math doesn't allow it on the target machine.
- **Never** add Playwright as a dependency to the fast-path code. The `playwright` import is strictly isolated to `src/worker/browser.processor.ts` and `src/worker/playwright.singleton.ts`.
- The SPA detector (`spa-detector.ts`) must remain a **pure function** — no network calls, no side effects. It receives signals collected during the SAX parse pass.
- `isSpa()` must return `false` whenever `mediaCount > 0`, regardless of the SPA score. This is the key rule that prevents re-queuing SSR pages (Next.js with SSR, Nuxt with SSR, etc.) to the slow browser queue.
- SPA detection is **opt-in per job** via `browserFallback: true`. When `false`, SPA-detected URLs are immediately marked `failed` with `error: "spa_detected"` and counted as done (they do not block job completion).
- **Never use `waitUntil: 'networkidle'`** in Playwright. Many SPAs continuously poll APIs — networkidle never fires and the URL burns the full 30s timeout. Use `domcontentloaded` + `waitForTimeout(1000)` + `autoScroll()`.
- `autoScroll` must have a hard cap of 60 steps maximum (enforced in zod config validation on `maxScrollDepth`).
- Extract `data-src`, `data-lazy`, `data-original` attributes alongside `src` — lazy-load libraries set these before the intersection observer fires.
- Block `stylesheet`, `font`, `image` resource types in Playwright. We read `src` attributes from the DOM — we do not need image downloads. Blocking saves ~50–200 MB per page load.

## What AI Agents Must NOT Do

- Do not change `SCRAPER_CONCURRENCY` default above 70 without benchmarking data.
- Do not create a new `pLimit()` instance per job — import `globalLimit` from `http-client.ts`.
- Do not switch from `undici` to another HTTP client.
- Do not add `Promise.all` on any array of unbounded size.
- Do not use `waitUntil: 'networkidle'` in Playwright — use `domcontentloaded`.
- Do not skip the 5 MB response size check — add both the Content-Length header check and the streaming byte-counter guard.
- Do not add new npm packages without checking: (a) bundle size impact, (b) active maintenance status, (c) whether an existing package already covers the need.
- Do not write raw SQL for queries that Prisma can express cleanly.
- Do not commit changes that cause TypeScript errors or ESLint failures.
- Do not remove `body.dump()` calls on non-200 responses.
- Do not store scraped HTML in memory longer than needed for parsing.
- Do not call `browser.close()` in any hot path — only in graceful shutdown handler.
- Do not increase `BrowserScrapeWorker` concurrency above 1.
- Do not import `playwright` outside of `browser.processor.ts` and `playwright.singleton.ts`.
- Do not change the DB schema without generating a migration file.
