# 01 — Fundamentals: Why This Is Feasible

## The Event Loop Model

Node.js uses a **single-threaded, non-blocking event loop**. When you fire an HTTP request, Node registers a callback and immediately moves on. The OS handles the actual socket I/O. When a response arrives, the event loop picks it up and executes your callback.

This means:

- **CPU usage while waiting for a remote server: ~0%**
- No OS threads, no context-switching overhead
- Thousands of sockets can be outstanding simultaneously

A classical thread-per-request server would need 5000 threads and gigabytes of stack memory. Node needs **one thread and a queue**.

## Why Scraping 5000 URLs Is I/O-Bound

Your scraper spends >99% of its time waiting for remote servers. The CPU is only needed for:

1. HTML/JSON parsing (~1–5 ms per page)
2. Data extraction / transformation (~0.1–1 ms)
3. Writing results to disk/DB (~0.1 ms)

Everything else is network wait time. This is Node's exact sweet spot.

## Constraint Analysis

### The 1 GB Memory Budget

| Component | Estimated Usage | Mitigation |
|-----------|----------------|------------|
| Node.js runtime + V8 heap baseline | 80–120 MB | Unavoidable |
| 5000 open TCP sockets (idle) | ~250 MB | Use connection pooling, reuse sockets |
| In-flight response buffers | 200–400 MB | **Stream responses** — never buffer full bodies |
| Parsed data / output queue | 50–150 MB | Flush to disk/DB immediately |
| GC headroom & spikes | 100 MB | Never exceed 85% utilization |

**Total budget: ~700–850 MB peak.** This is achievable with disciplined streaming and a concurrency limit of 100–200.

> **Critical risk:** Buffering full response bodies in memory. If 200 responses arrive simultaneously at 100 KB each, that is 20 MB of instantaneous allocation. Use streaming parsers and flush results immediately.

### The 1 CPU Core

A single CPU is sufficient for I/O orchestration. Risks arise from:

- **HTML parsing (Cheerio/JSDOM):** Synchronous, CPU-intensive. Blocks the event loop.
- **JSON.parse on large payloads:** Also synchronous.
- **Heavy regex / data transformation:** Blocks the event loop.

**Solution:** Offload CPU-intensive work to a `worker_threads` pool (2–4 workers). The main thread stays free for socket I/O scheduling. See [05-architecture.md](./05-architecture.md).

### What "5000 at the Same Time" Actually Means

You almost certainly do **not** want 5000 truly simultaneous open connections. What you want is to **process all 5000 URLs as fast as possible within a time window**.

The right in-flight concurrency limit is empirically **50–300**, depending on:
- Average response latency (higher latency → can tolerate higher concurrency)
- Average response body size (larger pages → lower concurrency to protect RAM)
- Target server rate limits (most servers will ban you above ~30 req/s per domain)

```
Throughput = Concurrency / Avg_Latency_Seconds

Example: 150 concurrent / 0.5s avg = 300 req/s
Example: 150 concurrent / 1.0s avg = 150 req/s

Time to finish 5000 URLs:
  5000 / 300 req/s = ~17 seconds
  5000 / 150 req/s = ~33 seconds
```

## What to Avoid Entirely

| Approach | Why It Fails on 1 CPU / 1 GB |
|----------|------------------------------|
| `Promise.all(urls.map(fetch))` | Opens 5000 sockets instantly, OOMs immediately |
| Puppeteer / Playwright | 200–600 MB per browser instance; 2 instances = full RAM |
| Storing all results in RAM | `results.push(html)` × 5000 = OOM |
| No timeouts | Hung sockets fill concurrency pool indefinitely |
| axios without keep-alive | No native pooling; ECONNRESET under heavy load |
