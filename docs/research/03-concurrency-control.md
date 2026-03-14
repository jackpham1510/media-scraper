# 03 — Concurrency Control, Queue Design & Backpressure

## The Naive Approach (Never Do This)

```js
// ❌ BROKEN: fires all 5000 requests simultaneously
const results = await Promise.all(urls.map(url => fetch(url)));
```

This:
- Opens 5000 TCP sockets instantly
- Allocates 5000 response buffers simultaneously
- OOMs the process within seconds
- Gets your IP banned by target servers

---

## Correct Mental Model: Bounded Work Queue

Think of it as a **sliding window** over your URL list. Exactly N requests are in-flight at any moment. As each completes, the next URL dequeues automatically.

```
URL list:  [url1, url2, url3, ... url5000]
Window N=3: [url1✓, url2✓, url3⏳] → [url4⏳, url2✓, url3⏳] → ...
```

---

## Option A: `p-limit` (Recommended)

Minimal, zero-dependency, battle-tested. Best for straightforward scraping.

```bash
npm install p-limit
```

```js
import pLimit from 'p-limit';
import { request } from 'undici';

const CONCURRENCY = 150;
const limit = pLimit(CONCURRENCY);

async function scrapeAll(urls) {
  const tasks = urls.map(url =>
    limit(async () => {
      try {
        const { statusCode, body } = await request(url, {
          headersTimeout: 10_000,
          bodyTimeout: 30_000,
        });
        const html = await body.text();
        return { url, statusCode, html, error: null };
      } catch (err) {
        return { url, statusCode: null, html: null, error: err.message };
      }
    })
  );

  // allSettled: one failure never aborts the batch
  return Promise.allSettled(tasks);
}
```

> **Why `allSettled` not `all`?** With 5000 URLs, some will fail. `Promise.all` throws on the first rejection and abandons all remaining work. `allSettled` collects every result.

---

## Option B: `Bottleneck` (Advanced)

Use when you need:
- Per-domain rate limiting (e.g. max 10 req/s to any single domain)
- Priority queues (premium URLs processed first)
- Redis-based distributed rate limiting across multiple processes

```bash
npm install bottleneck
```

```js
import Bottleneck from 'bottleneck';
import { request } from 'undici';

// Global concurrency cap + per-domain rate limiting
const globalLimiter = new Bottleneck({
  maxConcurrent: 150,
  minTime: 0,
  highWater: 6000,    // max queue depth before dropping
  strategy: Bottleneck.strategy.OVERFLOW_PRIORITY,
});

// Per-domain limiter factory (avoid hammering a single site)
const domainLimiters = new Map();

function getDomainLimiter(hostname) {
  if (!domainLimiters.has(hostname)) {
    domainLimiters.set(hostname, new Bottleneck({
      maxConcurrent: 5,     // max 5 concurrent to any single domain
      minTime: 200,         // at least 200ms between requests to same domain
    }));
  }
  return domainLimiters.get(hostname);
}

async function scrapeUrl(url) {
  const hostname = new URL(url).hostname;
  const domainLimiter = getDomainLimiter(hostname);

  // Chain: global cap → domain cap → actual request
  return globalLimiter.schedule(() =>
    domainLimiter.schedule(() => fetchAndParse(url))
  );
}
```

---

## Option C: Async Generator Queue (Memory-Efficient)

The approaches above still create all N promise objects upfront via `.map()`. For true memory efficiency, feed URLs lazily using an async generator:

```js
import pLimit from 'p-limit';

async function* urlSource(urls) {
  for (const url of urls) yield url;
  // Can also yield from a database cursor, file stream, etc.
}

async function runQueue(urls, concurrency = 150) {
  const limit = pLimit(concurrency);
  const active = new Set();
  let completed = 0;

  for await (const url of urlSource(urls)) {
    const task = limit(async () => {
      const result = await scrapeOne(url);
      completed++;
      if (completed % 500 === 0) {
        console.log(`Progress: ${completed}/${urls.length}`);
      }
      return result;
    }).finally(() => active.delete(task));

    active.add(task);

    // Backpressure: if queue is saturated, wait for a slot
    if (active.size >= concurrency * 2) {
      await Promise.race(active);
    }
  }

  await Promise.allSettled(active);
}
```

**Memory benefit:** Never holds more than ~2×concurrency promise objects in RAM. Compare to `urls.map()` which allocates all 5000 upfront.

---

## Choosing Your Concurrency N

Start at N=100. Then tune empirically:

| Condition | Action |
|-----------|--------|
| RAM < 500 MB, no errors | Increase N by 50 |
| RAM > 750 MB | Decrease N by 25 |
| ECONNRESET errors appearing | Decrease N by 25 |
| HTTP 429 responses | Per-domain rate limit needed |
| CPU > 80% (parsing bottleneck) | Add more worker threads, not more concurrency |

| Scenario | Recommended N |
|----------|---------------|
| Unknown / mixed sites | 100–150 |
| Small responses (< 5 KB) | 200–300 |
| Large pages (> 100 KB) | 50–100 |
| Single domain, rate-limited | 10–30 |

---

## Backpressure: Protecting the Output Sink

If your output sink (file, database, message queue) is slower than your scrape rate, results pile up in memory. Apply backpressure at the write layer:

```js
import { createWriteStream } from 'fs';

const out = createWriteStream('results.ndjson', { flags: 'a' });

async function writeResult(result) {
  const line = JSON.stringify(result) + '\n';
  const flushed = out.write(line);

  // Respect the stream's highWaterMark
  if (!flushed) {
    await new Promise(resolve => out.once('drain', resolve));
  }
}
```

For database writes, use a micro-batch buffer:

```js
const BATCH_SIZE = 500;
const FLUSH_INTERVAL = 5000; // ms
const buffer = [];

async function flushBuffer(db) {
  if (buffer.length === 0) return;
  const batch = buffer.splice(0, buffer.length);
  await db.bulkInsert(batch);
}

async function writeResult(result, db) {
  buffer.push(result);
  if (buffer.length >= BATCH_SIZE) {
    await flushBuffer(db);
  }
}

// Also flush on interval
setInterval(() => flushBuffer(db), FLUSH_INTERVAL);
```
