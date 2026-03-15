# Media Scraper — Technical Design Document

> Status: Approved
> Last updated: 2026-03-14 (rev 3 — engineering review applied)

---

## 1. Requirements Summary

- Accept a batch of Web URLs via API
- Scrape image and video URLs from each page
- Store results in MySQL
- React frontend: grid gallery with pagination, type filter, text search
- Node.js (TypeScript) backend, React (TypeScript) frontend
- Dockerized via Docker Compose
- **Handle 5000 concurrent API clients** on a server with 1 CPU and 1 GB RAM
- Load test required

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    React SPA (Vite + React)                      │
│  - POST batch of URLs → get jobId                               │
│  - Poll job status (or SSE for live progress)                   │
│  - Grid gallery: paginated, filtered by type, searchable        │
└───────────────────────────┬─────────────────────────────────────┘
                            │ HTTP REST
┌───────────────────────────▼─────────────────────────────────────┐
│               Monolith Node.js Service (Fastify + TypeScript)    │
│                                                                  │
│  ┌──────────────────────┐    ┌────────────────────────────────┐  │
│  │    API Layer         │    │   FastScrapeWorker             │  │
│  │  (Fastify routes)    │    │   BullMQ concurrency: 2        │  │
│  │                      │    │   global p-limit(70) singleton │  │
│  │  POST /scrape        │    │   undici + htmlparser2 SAX     │  │
│  │  GET  /scrape/:id    │    │   (main thread, no workers)    │  │
│  │  GET  /media         │    │   → SPA detected? re-queue ──┐ │  │
│  │  GET  /media/:id     │    └────────────────────────────┐ │ │  │
│  └──────────┬───────────┘                                 │ │ │  │
│             │ enqueue (fast)          ┌───────────────────┘ │ │  │
│             ▼                        │ (if browserFallback) │ │  │
│  ┌──────────────────────┐            ▼                      │ │  │
│  │  scrape:fast queue   │   ┌────────────────────────────┐  │ │  │
│  │  (BullMQ, priority 1)│   │  BrowserScrapeWorker       │  │ │  │
│  └──────────────────────┘   │  BullMQ concurrency: 1     │  │ │  │
│                             │  Playwright (singleton)    │◄─┘ │  │
│  ┌──────────────────────┐   │  Sequential, lowest prio   │    │  │
│  │  scrape:browser queue│◄──│  page.close() after each   │    │  │
│  │  (BullMQ, priority 10│   └────────────────────────────┘    │  │
│  │   = lowest)          │                                      │  │
│  └──────────────────────┘                                      │  │
└───────────────┬───────────────────────────────┬─────────────────┘
                │                               │
   ┌────────────▼────────────┐    ┌─────────────▼──────────────┐
   │    MySQL 8              │    │    Redis 7                  │
   │  (scrape data)          │    │  (BullMQ queues + pub/sub)  │
   └─────────────────────────┘    └─────────────────────────────┘
```

### Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| API style | **Async (job-based)** | 5000 URLs takes 15–35s; sync HTTP would timeout |
| Monolith | **API + Worker in one process** | Simpler ops; modular internally; scales horizontally |
| Horizontal scaling | **Stateless via BullMQ + shared Redis** | Multiple instances pull from same queue |
| Job queue | **BullMQ** | Persistent, retryable, observable; Redis adds only ~40 MB |
| HTTP client | **undici** | 3–5× faster than axios; native connection pooling |
| HTML parsing | **htmlparser2 (SAX), main thread** | Event-driven streaming; callbacks are µs — no worker threads needed |
| p-limit scope | **Global process singleton** | Two BullMQ jobs × per-job p-limit = 140 actual requests; global cap enforces 70 total |
| Fast scraper concurrency | **p-limit(70) globally** | Leaves ~150 MB headroom for Playwright; enforced across all concurrent BullMQ jobs |
| SPA support | **Opt-in, lowest BullMQ priority** | Playwright is 300–400 MB; must not compete with fast path |
| SPA concurrency | **1 (strictly sequential)** | Only 1 Chromium instance fits in 1 GB budget |
| SPA detection | **Score-based heuristic** | Automatic; no user input needed to detect |

---

## 3. Deployment Topology on 1 CPU / 1 GB RAM

```
Docker Compose on 1 CPU / 1 GB RAM host
├── mysql:8         → 256 MB  (innodb_buffer_pool_size=256M)
├── redis:7-alpine  → 40 MB
└── api:            → 500 MB peak
    ├── Node.js baseline:          ~120 MB
    ├── Fast scraper (p-limit 70): ~270 MB active
    └── Playwright (1 instance):   ~300 MB  ← only when browser queue has work
        (fast + browser overlap is avoided by BullMQ priority — browser jobs
         only run when fast-path jobs drain, so RAM peaks don't fully overlap)
                       ─────────
           Worst-case overlap peak: ~690 MB + 256 + 40 = ~986 MB  ← tight but safe
           Normal operation peak:   ~500 MB  (no SPA work active)
```

**Instance count:** 1 Node.js instance on this machine. The design supports N instances on larger infrastructure — all stateless, all pulling from the same Redis-backed BullMQ queue.

**Node.js launch flags** (critical for 1 GB constraint):
```
node --max-old-space-size=480 --max-semi-space-size=64 dist/main.js
```
Note: reduced to 480 MB (from 500) to give Playwright's Chromium room to breathe alongside V8 heap.

**Environment variable:**
```
UV_THREADPOOL_SIZE=16   # prevents DNS bottleneck across many domains
```

### How 5000 Concurrent API Clients Are Handled

- `POST /scrape` is nearly instant — validates input, enqueues a BullMQ job, returns `{ jobId }`
- Fastify on Node.js handles 20k+ simple req/s on 1 core; 5000 concurrent POSTs = no problem
- Those 5000 jobs queue in Redis; the worker processes them with controlled concurrency (p-limit(100))
- Clients poll `GET /scrape/:id/status` — lightweight DB reads, cached in Redis for 2s

---

## 4. Tech Stack

### Backend
| Layer | Technology | Notes |
|-------|-----------|-------|
| Runtime | Node.js 22 (LTS) | Pointer compression on by default; best async performance |
| Language | TypeScript 5.x (strict mode) | `strict: true`, no `any` |
| Framework | **Fastify 5** | Schema-based validation; 2–3× faster than Express |
| Job Queue | **BullMQ 5** | Redis-backed; persistent; retryable; built-in concurrency |
| HTTP Client | **undici** (Node built-in) | Native; fastest; connection-pooled |
| HTML Parser | **htmlparser2** (SAX streaming) | Lowest memory; streaming pipeline |
| ORM | **Prisma** | TypeScript-first; type-safe queries; auto migrations |
| DB | MySQL 8 | Required |
| Cache/Queue | Redis 7 | BullMQ + job status cache |

### Frontend
| Layer | Technology |
|-------|-----------|
| Build | Vite 6 |
| Framework | React 19 |
| Language | TypeScript 5.x |
| Data Fetching | TanStack Query v5 (polling, pagination) |
| Styling | Tailwind CSS 4 |
| UI Components | shadcn/ui (Radix primitives) |
| HTTP Client | Axios (FE only; no scraping here) |

### Infrastructure
| Tool | Use |
|------|-----|
| Docker Compose | Local orchestration |
| k6 | Load testing (scripted in JS) |

---

## 5. Database Schema

```sql
-- Scraping jobs (one per API call)
CREATE TABLE scrape_jobs (
  id                   VARCHAR(36)   PRIMARY KEY,   -- UUID v4
  status               ENUM('pending','running','fast_complete','done','failed')
                       NOT NULL DEFAULT 'pending',
  -- fast_complete: fast queue finished, browser queue still has pending URLs
  browser_fallback     TINYINT(1)    NOT NULL DEFAULT 0,  -- opt-in flag from request
  max_scroll_depth     TINYINT UNSIGNED NOT NULL DEFAULT 10, -- browser path scroll steps
  urls_total           INT UNSIGNED  NOT NULL DEFAULT 0,
  urls_done            INT UNSIGNED  NOT NULL DEFAULT 0,
  urls_spa_detected    INT UNSIGNED  NOT NULL DEFAULT 0,  -- re-queued to browser path
  urls_browser_done    INT UNSIGNED  NOT NULL DEFAULT 0,  -- completed via Playwright
  created_at           DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at          DATETIME(3)   NULL,
  INDEX idx_status (status),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Individual URLs submitted in a job
CREATE TABLE scrape_requests (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  job_id       VARCHAR(36)     NOT NULL,
  url          TEXT            NOT NULL,
  status       ENUM('pending','processing','spa_detected','done','failed')
               NOT NULL DEFAULT 'pending',
  scrape_path  ENUM('fast','browser') NULL,        -- set when processing starts
  spa_score    TINYINT UNSIGNED NULL,              -- heuristic score (0–20); >= 6 = SPA
  error        TEXT             NULL,
  FOREIGN KEY (job_id) REFERENCES scrape_jobs(id) ON DELETE CASCADE,
  INDEX idx_job_status (job_id, status),
  INDEX idx_job_path   (job_id, scrape_path)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Scraped pages (one per URL successfully fetched)
CREATE TABLE scrape_pages (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  job_id       VARCHAR(36)   NOT NULL,
  source_url   VARCHAR(2048) NOT NULL,
  title        VARCHAR(1000) NULL,
  description  TEXT          NULL,
  scraped_at   DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (job_id) REFERENCES scrape_jobs(id) ON DELETE CASCADE,
  INDEX idx_job_id (job_id),
  INDEX idx_source_url (source_url(255))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Scraped media items (upserted by media_url)
CREATE TABLE media_items (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  page_id      BIGINT UNSIGNED NOT NULL,
  job_id       VARCHAR(36)     NOT NULL,
  source_url   VARCHAR(2048)   NOT NULL,  -- page the media came from
  media_url    VARCHAR(2048)   NOT NULL,  -- the img/video src
  media_url_hash CHAR(64)      NOT NULL,  -- SHA-256 of media_url for dedup
  media_type   ENUM('image','video') NOT NULL,
  alt_text     VARCHAR(1000)   NULL,
  created_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (page_id) REFERENCES scrape_pages(id) ON DELETE CASCADE,
  FOREIGN KEY (job_id)  REFERENCES scrape_jobs(id)  ON DELETE CASCADE,
  UNIQUE KEY uq_media_url_hash (media_url_hash),   -- dedup via upsert
  INDEX idx_job_id     (job_id),
  INDEX idx_media_type (media_type),
  INDEX idx_created_at (created_at),
  FULLTEXT idx_ft_search (alt_text)                -- for text search
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### Deduplication Strategy

Media URLs are deduplicated globally using a `SHA-256` hash of the normalized URL stored in `media_url_hash`. On insert, use `INSERT ... ON DUPLICATE KEY UPDATE` (upsert). This means the same media URL scraped across multiple jobs only creates one row; the most recent `job_id` wins.

### Text Search Strategy

- Search on `media_items.alt_text` via MySQL `FULLTEXT` index
- Search on `scrape_pages.title` + `scrape_pages.description` via `JOIN` + `FULLTEXT`
- For the MVP, this is sufficient. If search becomes slow, add Meilisearch.

---

## 6. API Contract

All endpoints: `Content-Type: application/json`

### Submit a scrape job
```
POST /api/scrape
Body: {
  "urls": ["https://example.com", "https://foo.com", ...],  // 1–5000 items
  "options": {
    "browserFallback": false,  // default: false
                               // if true: SPA-detected URLs are re-queued to the
                               // browser worker (Playwright) at lowest priority.
                               // if false: SPA-detected URLs are marked failed
                               // with reason "spa_detected".
    "maxScrollDepth": 10       // browser path only; number of scroll steps per page
                               // (400px/step, 200ms/step). Default: 10 (~4000px coverage).
                               // Increase for long product catalogs; capped at 60.
  }
}
Response 202: {
  "jobId": "uuid-v4"
}
Response 400: {
  "error": "urls must be a non-empty array of max 5000 items"
}
```

### Get job status
```
GET /api/scrape/:jobId
Response 200: {
  "id": "uuid-v4",
  "status": "fast_complete",    // pending | running | fast_complete | done | failed
                               // fast_complete: fast queue done, browser queue still active
  "browserFallback": true,      // echoes the opt-in flag
  "urlsTotal": 500,
  "urlsDone": 310,              // fast-path completed
  "urlsSpaDetected": 42,        // detected as SPA; re-queued if browserFallback=true
  "urlsBrowserDone": 12,        // completed via Playwright
  "urlsBrowserPending": 30,     // still queued in scrape:browser (lowest priority)
  "createdAt": "2026-03-14T10:00:00.000Z",
  "finishedAt": null
}

Note: a job reaches status "done" only when BOTH fast-path and browser-path
URLs are complete (if browserFallback=true). The client can display a
two-phase progress indicator using urlsDone vs urlsBrowserDone.
```

### List media (paginated, filtered, searchable)
```
GET /api/media?page=1&limit=20&type=image&search=cat&jobId=<optional>

Query params:
  page    integer  default: 1
  limit   integer  default: 20, max: 100
  type    string   "image" | "video" | omit for all
  search  string   searches alt_text, page title, page description
  jobId   string   filter to a specific scrape job

Response 200: {
  "data": [
    {
      "id": 1,
      "jobId": "uuid",
      "sourceUrl": "https://example.com",
      "mediaUrl": "https://example.com/img/hero.jpg",
      "mediaType": "image",
      "altText": "Hero image",
      "pageTitle": "Example Domain",
      "pageDescription": "This is an example page.",
      "createdAt": "2026-03-14T10:01:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 4823,
    "totalPages": 242
  }
}
```

### Get single media item
```
GET /api/media/:id
Response 200: MediaItem (same shape as above)
Response 404: { "error": "Not found" }
```

---

## 7. Scraping Architecture & Performance Strategy

### Two-Tier Pipeline Overview

```
All URLs
  │
  ▼
scrape:fast queue (BullMQ priority: 1 = high)
  │
  ▼
FastScrapeWorker  ─── p-limit(70) ──▶ undici + htmlparser2 SAX
  │
  ├── media found → batch write to DB → done ✓
  │
  └── SPA detected (score ≥ 6)
        │
        ├── browserFallback=false → mark failed, reason: "spa_detected"
        │
        └── browserFallback=true  → enqueue to scrape:browser (priority: 10)
                                         │
                                         ▼
                              BrowserScrapeWorker
                              concurrency: 1 (sequential)
                              Playwright singleton instance
                              domcontentloaded → scroll → extract DOM media
                              page.close() after every URL
                              batch write to DB → done ✓
```

### Fast-Path Pipeline (Per URL)

```
URL input
  │
  ▼
undici Agent (connection pool, 10 conns/origin)
  │  headersTimeout: 10s / bodyTimeout: 30s / connectTimeout: 5s
  ▼
Content-Length header check → > 5 MB? → body.dump() + mark failed: "response_too_large"
  │
  ▼
statusCode check → non-200? → body.dump() + record error
  │
  ▼
SAX streaming parser (htmlparser2 WritableStream) — runs on main thread
  │  pipes response body through size-guard Transform (5 MB byte counter)
  │  → exceeds limit mid-stream? → abort pipeline + mark failed
  │  collects: <img src alt>, <video src>, <source src>
  │  collects: <title> text, <meta name="description" content>
  │  collects SPA signals: root div id, script count, body text length
  ▼
SPA Detection (spa-detector.ts) — pure function, no I/O
  │  score-based heuristic (see below)
  │  mediaCount > 0 → NOT SPA regardless of score (SSR served content)
  │  mediaCount = 0 AND score ≥ 6 → SPA
  ▼
  ├── Not SPA → Batch DB write (500 rows / 5s flush)
  └── SPA     → re-queue or mark failed (per browserFallback flag)
```

### SPA Detection Heuristic

```typescript
// spa-detector.ts
// Signals collected during SAX parsing — no extra HTTP round-trip
interface SpaSignals {
  hasRootDiv: boolean;        // <div id="root|app|__next|__nuxt">
  hasNextData: boolean;       // window.__NEXT_DATA__ in inline script
  hasNuxtData: boolean;       // window.__NUXT__ in inline script
  hasNoScriptWarning: boolean; // <noscript> contains "enable javascript"
  bodyTextLength: number;     // visible text characters (tags stripped)
  scriptTagCount: number;
  mediaCount: number;         // img + video + source tags with src
}

function scoreSpa(signals: SpaSignals): number {
  let score = 0;
  if (signals.hasRootDiv)          score += 4;
  if (signals.hasNextData)         score += 3; // Next.js CSR (SSR would have content)
  if (signals.hasNuxtData)         score += 3;
  if (signals.hasNoScriptWarning)  score += 5;
  if (signals.bodyTextLength < 300) score += 3;
  if (signals.scriptTagCount > 5 && signals.mediaCount === 0) score += 3;
  return score;
}

// Threshold: 6 → SPA (tune empirically during testing)
// Key insight: if mediaCount > 0, don't re-queue even if score is high —
// the site served useful content (SSR or hybrid rendering).
```

### Browser-Path Pipeline (Per URL)

```
URL dequeued from scrape:browser
  │  BullMQ worker concurrency: 1 — never more than 1 URL at a time
  ▼
Playwright browser.newPage()
  │
  ├── Block: stylesheet, font, image resource types
  │   (we read src attributes from DOM; we don't need image downloads)
  │
  ▼
page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  │  domcontentloaded: HTML parsed, scripts executed, intersection observers registered
  │  (networkidle avoided — many SPAs poll APIs continuously and never reach it)
  ▼
page.waitForTimeout(1_000)
  │  gives React/Vue one render cycle to mount components
  ▼
autoScroll(page, { steps: maxScrollDepth, stepPx: 400, delayMs: 200 })
  │  scrolls incrementally to trigger Intersection Observer lazy loading
  │  src attribute is SET by JS even though image download is blocked
  ▼
page.$$eval('img, video, source', els => ...)
  │  extract: src || data-src || data-lazy || data-original
  │  also: document.title, meta[name="description"]
  │  filter: skip data: URIs and empty strings
  ▼
page.close()   ← ALWAYS in finally block — releases Chromium tab memory
  │
  ▼
Batch DB write (same repository as fast path)
```

#### autoScroll Implementation

```typescript
async function autoScroll(
  page: Page,
  opts: { steps: number; stepPx: number; delayMs: number }
): Promise<void> {
  await page.evaluate(async ({ steps, stepPx, delayMs }) => {
    await new Promise<void>(resolve => {
      let count = 0;
      const timer = setInterval(() => {
        window.scrollBy(0, stepPx);
        count++;
        if (count >= steps ||
            window.scrollY + window.innerHeight >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, delayMs);
    });
  }, opts);
}
// Default: 10 steps × 400px × 200ms = ~4000px coverage in ~2s
// Max: 60 steps (enforced in config validation)
```

### Playwright Singleton Configuration

```typescript
// One browser instance for the lifetime of the worker process
// Never launch per-URL — that's 300MB × N
const browser = await chromium.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',     // /dev/shm is 64MB in Docker by default
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--js-flags=--max-old-space-size=200',
  ],
});

// On graceful shutdown: await browser.close()
// On crash/restart: BullMQ re-queues the failed job automatically
```

### Concurrency Control (Fast Path)

The `p-limit` instance is a **process-level singleton**, not created per-job. This is critical: `FastScrapeWorker` runs with `concurrency: 2` (two BullMQ jobs in parallel), and each job uses the same shared limiter. Without this, two simultaneous jobs would each create their own `p-limit(70)` — resulting in 140 actual concurrent requests and blowing the memory budget.

```typescript
// scraper/http-client.ts — process singleton, imported everywhere
export const globalLimit = pLimit(SCRAPER_CONCURRENCY); // default: 70

// fast.processor.ts — uses the shared limiter
import { globalLimit } from '../scraper/http-client';

const tasks = urls.map(url => globalLimit(() => scrapeOne(url)));
await Promise.allSettled(tasks); // ALWAYS allSettled, never Promise.all
```

### Response Size Limit

```typescript
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB

// Fast path: Content-Length header check (free — no bytes read)
const contentLength = parseInt(headers['content-length'] ?? '0', 10);
if (contentLength > MAX_BODY_BYTES) {
  await body.dump();
  return { error: 'response_too_large' };
}

// Guard during streaming — handles chunked responses with no Content-Length
let bytesRead = 0;
const sizeGuard = new Transform({
  transform(chunk, _enc, cb) {
    bytesRead += chunk.length;
    bytesRead > MAX_BODY_BYTES
      ? cb(new Error('response_too_large'))
      : cb(null, chunk);
  }
});

await pipeline(body, sizeGuard, saxParser); // stream chain, no buffering
```

### Rate Limiting

```typescript
// Protects against queue flooding: 5000 clients × 5000 URLs = 25M queued rows
await fastify.register(rateLimit, {
  max:            parseInt(process.env.RATE_LIMIT_MAX    ?? '10'),
  timeWindow:     process.env.RATE_LIMIT_WINDOW ?? '1m',
  redis:          redisClient,  // shared Redis instance
  keyGenerator:   (req) => req.ip,
  errorResponseBuilder: () => ({
    error: 'rate_limit_exceeded',
    retryAfter: 60,
  }),
});

// Additional: queue depth cap (503 if backlog too large)
const waiting = await scrapeQueue.getWaitingCount();
if (waiting > parseInt(process.env.QUEUE_MAX_DEPTH ?? '50000')) {
  reply.code(503).send({ error: 'queue_full', retryAfter: 30 });
  return;
}
```

**Env vars** (all in `config/` zod schema):
```
RATE_LIMIT_MAX=10       # requests per window per IP
RATE_LIMIT_WINDOW=1m    # time window (ms|s|m|h)
QUEUE_MAX_DEPTH=50000   # max waiting jobs in BullMQ before 503
```

### Job Completion — Atomic Status Transitions

Job completion is detected entirely inside single `UPDATE` statements — no separate SELECT, no race conditions.

**Fast worker, when its BullMQ job finishes:**
```sql
UPDATE scrape_jobs
SET
  status = CASE
    WHEN urls_spa_detected = 0 THEN 'done'   -- no browser work needed
    ELSE 'fast_complete'                      -- browser queue still has URLs
  END,
  finished_at = CASE
    WHEN urls_spa_detected = 0 THEN NOW(3)
    ELSE NULL
  END
WHERE id = :jobId AND status = 'running';
```

**Browser worker, after each URL completes:**
```sql
UPDATE scrape_jobs
SET
  urls_browser_done = urls_browser_done + 1,
  status = CASE
    WHEN status = 'fast_complete'
     AND urls_browser_done + 1 >= urls_spa_detected THEN 'done'
    ELSE status
  END,
  finished_at = CASE
    WHEN status = 'fast_complete'
     AND urls_browser_done + 1 >= urls_spa_detected THEN NOW(3)
    ELSE NULL
  END
WHERE id = :jobId;
```

MySQL evaluates `CASE` and `SET` atomically. Browser worker `concurrency: 1` means there's never concurrent completion for the same job — doubly safe.

**Watchdog (run every 5 min via `setInterval`):**
```sql
UPDATE scrape_jobs
SET status = 'failed'
WHERE status IN ('running', 'fast_complete')
  AND created_at < NOW() - INTERVAL 30 MINUTE;
```

**Crash recovery:** Some media results may be lost on process crash (batch not yet flushed). This is acceptable — stated explicitly in `docs/guardrails.md`.

### scrape_requests Lookup Pattern

Workers update individual URL rows by primary key. Row IDs are fetched at job creation and passed in the BullMQ job payload — no `url TEXT` scan required.

```typescript
// At job creation — fetch IDs immediately after bulk insert
const rows = await db.scrapeRequest.createMany({ data: urlRows });
const requestIds = await db.scrapeRequest.findMany({
  where: { jobId },
  select: { id: true, url: true }
});

// BullMQ job payload includes IDs
const payload: FastJobPayload = {
  jobId,
  browserFallback,
  maxScrollDepth,
  urls: requestIds.map(r => ({ id: r.id, url: r.url })),
};

// Processor updates by primary key — O(1), no scan
await db.$executeRaw`
  UPDATE scrape_requests SET status = ${status}, scrape_path = 'fast'
  WHERE id = ${requestId}
`;
```

### BullMQ Priority Configuration

```typescript
// Lower number = higher priority in BullMQ
const FAST_PRIORITY   = 1;   // processed immediately
const BROWSER_PRIORITY = 10; // processed only when fast queue is empty

// Fast worker: picks up jobs from scrape:fast
const fastWorker = new Worker('scrape:fast', fastProcessor, {
  concurrency: 2,  // 2 jobs processed in parallel (each uses p-limit internally)
});

// Browser worker: picks up jobs from scrape:browser — strictly sequential
const browserWorker = new Worker('scrape:browser', browserProcessor, {
  concurrency: 1,  // hard cap: 1 Playwright page at a time
});
```

### Resilience Stack

```
Per-URL retry: exponential backoff, max 3 retries
  Retryable: ECONNRESET, ETIMEDOUT, HTTP 429/500/502/503/504
  Not retried: HTTP 404, 403, 401, TLS errors

Per-domain circuit breaker:
  Open after 10 failures, reset after 60s
  Prevents hammering a failing origin

HTTP 429 handling:
  Respect Retry-After header
  Fall back to 5s wait if header absent

Dead letter: URLs exhausting all retries → logged with error
```

### Memory Discipline (Critical for 1 GB)

- Stream response bodies through size-guard Transform — cap at 5 MB, never buffer
- `body.dump()` on any non-200 immediately (socket returns to pool)
- Batch writes to DB — never accumulate results in RAM array
- `Promise.allSettled` — ensures failed tasks release memory promptly
- Node heap capped: `--max-old-space-size=480`
- SAX parser runs on main thread — htmlparser2 callbacks are µs, not blocking
- Media lost on process crash during batch flush is acceptable (documented decision)

### OS-Level Configuration (in Docker)

```yaml
# docker-compose.yml
ulimits:
  nofile: { soft: 65536, hard: 65536 }
mem_limit: 580m      # hard cap for node container
environment:
  - UV_THREADPOOL_SIZE=16
  - NODE_OPTIONS=--max-old-space-size=480 --max-semi-space-size=64
```

---

## 8. Project Structure

```
media-scraper/
├── packages/
│   ├── api/                     # Fastify app + BullMQ worker (monolith)
│   │   ├── src/
│   │   │   ├── main.ts          # entry point (starts Fastify + BullMQ worker)
│   │   │   ├── config/          # env validation (zod)
│   │   │   ├── routes/          # Fastify route plugins
│   │   │   │   ├── scrape.ts
│   │   │   │   └── media.ts
│   │   │   ├── worker/          # BullMQ job processors
│   │   │   │   ├── fast.worker.ts         # FastScrapeWorker (concurrency 2)
│   │   │   │   ├── fast.processor.ts      # per-URL fast-path logic
│   │   │   │   ├── browser.worker.ts      # BrowserScrapeWorker (concurrency 1)
│   │   │   │   ├── browser.processor.ts   # per-URL Playwright logic
│   │   │   │   └── playwright.singleton.ts # single browser instance lifecycle
│   │   │   ├── scraper/         # core scraping engine
│   │   │   │   ├── http-client.ts         # undici agent setup
│   │   │   │   ├── parser.ts              # htmlparser2 SAX streaming
│   │   │   │   ├── spa-detector.ts        # score-based SPA heuristic
│   │   │   │   ├── circuit-breaker.ts
│   │   │   │   └── retry.ts
│   │   │   ├── db/              # Prisma client + repositories
│   │   │   │   ├── prisma/
│   │   │   │   │   └── schema.prisma
│   │   │   │   ├── repositories/
│   │   │   │   │   ├── job.repository.ts
│   │   │   │   │   └── media.repository.ts
│   │   │   │   └── index.ts
│   │   │   └── types/           # shared TypeScript types/interfaces
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── web/                     # React frontend
│       ├── src/
│       │   ├── main.tsx
│       │   ├── App.tsx
│       │   ├── pages/
│       │   │   ├── HomePage.tsx         # URL submit form + job tracker
│       │   │   └── GalleryPage.tsx      # media grid
│       │   ├── components/
│       │   │   ├── MediaGrid.tsx
│       │   │   ├── MediaCard.tsx
│       │   │   ├── JobStatus.tsx
│       │   │   └── Filters.tsx
│       │   ├── hooks/
│       │   │   ├── useJobStatus.ts      # TanStack Query polling
│       │   │   └── useMedia.ts          # paginated media fetch
│       │   └── api/                     # typed API client
│       ├── Dockerfile
│       ├── package.json
│       └── tsconfig.json
├── docker-compose.yml
├── docker-compose.prod.yml
├── docs/
│   ├── draft-media-scraper.md
│   ├── technical-design.md       # this file
│   ├── execution-plan.md
│   ├── guardrails.md
│   └── research/
└── load-test/
    └── k6-scrape.js              # k6 load test script
```

---

## 9. Load Testing Strategy

Tool: **k6** — scripted in JS, Docker-friendly, excellent HTTP metrics

```
Scenario: ramp 0 → 5000 virtual users over 30s
  Each VU: POST /api/scrape with 10 URLs, then poll status until done
  Measure: p95 response time on POST, throughput, error rate

Success criteria:
  - POST /api/scrape p95 < 500ms under 5000 concurrent clients
  - Error rate < 0.1%
  - All jobs eventually reach "done" or "failed" status
  - No OOM crashes (monitor docker stats)
```

Load test script at: `load-test/k6-scrape.js`

---

## 10. Decisions Log

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Async API with jobId | 5000 URL scraping takes 15–35s; sync HTTP unsustainable |
| 2 | BullMQ over in-process queue | Survives restarts; observable; horizontally scalable |
| 3 | Monolith (API + Worker) | Simpler ops; modular internally; same image scales horizontally |
| 4 | 1 Node.js instance on demo machine | Memory math: MySQL 256MB + Redis 40MB + Node 570MB ≈ 866MB |
| 5 | p-limit(70) as global singleton | Two BullMQ jobs × per-job p-limit = 140 requests; global cap enforces budget |
| 6 | undici over axios | 3–5× faster; native pooling; essential for 5000 URL load |
| 7 | htmlparser2 SAX over cheerio | Stream-based; never buffers full DOM; critical for RAM |
| 8 | htmlparser2 on main thread (no worker threads) | SAX callbacks are µs — worker threads add IPC overhead with zero benefit |
| 9 | Global media dedup via SHA-256 | Same media URL scraped twice → upsert, single row |
| 10 | MySQL FULLTEXT for search | Sufficient for MVP; avoids another service dependency |
| 11 | Fastify over Express | Schema validation built-in; 2–3× req/s; TypeScript-first |
| 12 | Prisma as ORM | Best TypeScript DX; auto-generates types from schema |
| 13 | SPA support opt-in via `browserFallback` flag | Protects fast-path clients from unexpected 25–50 min waits; caller decides |
| 14 | SPA queue lowest BullMQ priority (10 vs 1) | Fast-path always drains first; Playwright only runs when fast queue is empty |
| 15 | Browser worker concurrency: 1 | Only 1 Chromium fits in 1 GB budget alongside MySQL + Redis + fast scraper |
| 16 | Playwright singleton (1 browser, N pages) | Launching per-URL costs 300 MB each; reusing browser keeps overhead to ~300 MB total |
| 17 | `page.close()` after every URL (not `browser.close()`) | Releases Chromium tab memory; keeps warm browser for next URL |
| 18 | SPA detection from SAX signals (no extra request) | Reuses data collected during fast-path parse; zero extra latency/cost |
| 19 | Load test scope: static HTML only | Browser path is ~100× slower; load test validates the 5000-concurrent claim on fast path |
| 20 | `fast_complete` intermediate status | Two-phase job: fast queue done but browser queue still active; enables two-phase UI progress |
| 21 | Job completion via atomic SQL UPDATE | Status transition inside single UPDATE WHERE clause — no SELECT + UPDATE race condition |
| 22 | scrape_request IDs in BullMQ payload | Update rows by PK not by url TEXT scan; fetched at enqueue time, passed in payload |
| 23 | `domcontentloaded` + scroll (not `networkidle`) | networkidle hangs on SPAs with polling APIs; domcontentloaded + 1s init + scroll is reliable |
| 24 | autoScroll for lazy loading | Intersection Observers require viewport entry; scrolling triggers src attribute assignment |
| 25 | `maxScrollDepth` configurable (default 10) | Prevents infinite scroll pages from running forever; power users can increase |
| 26 | `data-src` / `data-lazy` extraction fallback | Captures lazy-load lib patterns where observer hasn't fired yet |
| 27 | 5 MB response size cap | Prevents huge HTML files from holding p-limit slots; Content-Length fast path + stream guard |
| 28 | Media lost on crash is acceptable | Simplifies processor — no transactional batch flush needed; explicitly documented |
