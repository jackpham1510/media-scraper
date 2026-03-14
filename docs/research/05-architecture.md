# 05 — System Architecture & Worker Threads

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Main Node.js Process                     │
│                                                             │
│  ┌─────────────┐    ┌──────────────────────────────────┐   │
│  │  URL Source │───▶│   Concurrency Limiter            │   │
│  │  (generator)│    │   p-limit(N) / Bottleneck        │   │
│  └─────────────┘    └────────────────┬─────────────────┘   │
│                                      │                      │
│                                      ▼                      │
│                       ┌──────────────────────────────┐      │
│                       │   undici Agent               │      │
│                       │   per-host connection pool   │      │
│                       └──────────────┬───────────────┘      │
│                                      │                      │
│                 ┌────────────────────▼──────────────────┐   │
│                 │           Event Loop                   │   │
│                 │  (fires I/O, collects completions)     │   │
│                 └──────────┬────────────────────────────┘   │
│                            │                                │
│              ┌─────────────▼──────────────┐                │
│              │   Worker Thread Pool        │                │
│              │   (HTML parsing: 2–4 wrkrs) │                │
│              └─────────────┬──────────────┘                │
│                            │                                │
│              ┌─────────────▼──────────────┐                │
│              │   Output Sink              │                │
│              │   stream → file / DB / MQ  │                │
│              └────────────────────────────┘                │
└─────────────────────────────────────────────────────────────┘
                            │
              ┌─────────────▼─────────────┐
              │   Remote Servers          │
              │   (responding async)      │
              └───────────────────────────┘
```

**Data flow:**
1. URL generator feeds one URL at a time into the limiter
2. Limiter admits up to N tasks concurrently
3. Each task fires an HTTP request via the undici Agent
4. Event loop receives responses as they arrive from the OS
5. Raw HTML/JSON is posted to a worker thread for parsing
6. Parsed results stream to the output sink immediately

---

## Worker Threads for HTML Parsing

### Why

Cheerio, JSDOM, and even `node-html-parser` are **synchronous and CPU-intensive**. Running them on the main thread stalls the event loop and reduces I/O throughput. Each parse call blocks all other callbacks — including receiving new responses.

On a 1 CPU machine with N=150 concurrency, even 5 ms of synchronous parsing per page = 750 ms of blocked event loop per second = 25% throughput loss.

### Implementation

**`parser-worker.js`** — runs in worker thread:

```js
import { parentPort } from 'worker_threads';
import { parse } from 'node-html-parser'; // faster than cheerio for simple queries

parentPort.on('message', ({ id, html, url }) => {
  try {
    const root = parse(html, {
      lowerCaseTagName: true,
      comment: false,        // skip comments
      fixNestedATags: false, // skip auto-repair, faster
    });

    const result = {
      id,
      url,
      title:       root.querySelector('title')?.text?.trim() ?? null,
      description: root.querySelector('meta[name="description"]')
                       ?.getAttribute('content') ?? null,
      h1:          root.querySelector('h1')?.text?.trim() ?? null,
      links:       root.querySelectorAll('a[href]')
                       .map(a => a.getAttribute('href'))
                       .filter(Boolean)
                       .slice(0, 50), // limit link extraction
    };

    parentPort.postMessage({ id, result, error: null });
  } catch (err) {
    parentPort.postMessage({ id, result: null, error: err.message });
  }
});
```

**`worker-pool.js`** — round-robin pool manager:

```js
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class ParserPool {
  constructor(size = 3) {
    this.workers = Array.from({ length: size }, () =>
      new Worker(path.join(__dirname, 'parser-worker.js'))
    );
    this.pending = new Map(); // id → { resolve, reject }
    this.counter = 0;
    this.index = 0;

    for (const worker of this.workers) {
      worker.on('message', ({ id, result, error }) => {
        const { resolve, reject } = this.pending.get(id);
        this.pending.delete(id);
        if (error) reject(new Error(error));
        else resolve(result);
      });

      worker.on('error', err => console.error('Worker error:', err));
    }
  }

  parse(html, url) {
    return new Promise((resolve, reject) => {
      const id = this.counter++;
      this.pending.set(id, { resolve, reject });

      // Round-robin across workers
      const worker = this.workers[this.index % this.workers.length];
      this.index++;
      worker.postMessage({ id, html, url });
    });
  }

  terminate() {
    return Promise.all(this.workers.map(w => w.terminate()));
  }
}
```

**`scraper.js`** — main orchestrator:

```js
import pLimit from 'p-limit';
import { Agent, request } from 'undici';
import { ParserPool } from './worker-pool.js';
import { createWriteStream } from 'fs';

const CONCURRENCY = 150;
const WORKER_COUNT = 3; // 2–4 for 1 CPU

const agent = new Agent({
  connections: 10,
  headersTimeout: 10_000,
  bodyTimeout: 30_000,
  connectTimeout: 5_000,
});

const pool = new ParserPool(WORKER_COUNT);
const limit = pLimit(CONCURRENCY);
const out = createWriteStream('results.ndjson');

async function scrapeOne(url) {
  const { statusCode, body } = await request(url, { dispatcher: agent });

  if (statusCode !== 200) {
    await body.dump();
    return { url, error: `HTTP ${statusCode}` };
  }

  const html = await body.text(); // buffer only after status check
  const parsed = await pool.parse(html, url);
  return { url, ...parsed };
}

async function main(urls) {
  const tasks = urls.map(url =>
    limit(async () => {
      try {
        const result = await scrapeOne(url);
        const flushed = out.write(JSON.stringify(result) + '\n');
        if (!flushed) await new Promise(r => out.once('drain', r));
      } catch (err) {
        const line = JSON.stringify({ url, error: err.message }) + '\n';
        out.write(line);
      }
    })
  );

  await Promise.allSettled(tasks);
  await new Promise(r => out.end(r));
  await pool.terminate();
  await agent.close();
}
```

---

## Parser Library Comparison

| Library | Speed | Memory | API Style |
|---------|-------|--------|-----------|
| **node-html-parser** | ★★★★★ Fastest | ★★★★☆ Low | jQuery-like selectors |
| **htmlparser2** (SAX) | ★★★★☆ Fast | ★★★★★ Lowest | Event-driven streaming |
| **cheerio** | ★★★☆☆ Medium | ★★★☆☆ Medium | jQuery API, familiar |
| **JSDOM** | ★★☆☆☆ Slow | ★★☆☆☆ High | Full DOM API |
| **Playwright DOM** | ★☆☆☆☆ Very slow | ★☆☆☆☆ Very high | Full browser |

For 5000 URLs on 1 CPU: use **node-html-parser** in worker threads, or **htmlparser2** in SAX streaming mode for the lowest possible memory footprint.

---

## Output Sink Options

| Sink | Throughput | Durability | Notes |
|------|-----------|------------|-------|
| NDJSON file stream | Very high | Medium | Simple, works offline, easy to process later |
| SQLite (better-sqlite3) | High | High | Synchronous, but fast. Use WAL mode. Run in worker thread. |
| PostgreSQL (bulk insert) | High | High | Batch 500 rows per INSERT |
| Redis stream | Very high | Configurable | Good for multi-consumer pipelines |
| Kafka | Very high | High | Overkill for single-machine, great for distributed |

**Recommended for single-machine scraping:** NDJSON file → post-process with `jq` or load into DB after.
