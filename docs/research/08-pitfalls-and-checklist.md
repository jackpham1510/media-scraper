# 08 — Common Pitfalls & Final Checklist

## Anti-Patterns (Never Do These)

### ❌ Promise.all on all URLs simultaneously

```js
// WRONG: creates 5000 in-flight requests at once
const results = await Promise.all(urls.map(url => fetch(url)));
```

**Why it fails:** Allocates 5000 promise objects and opens 5000 TCP sockets simultaneously. OOMs within seconds on 1 GB RAM.

**Fix:** Use `p-limit` with N=100–200. See [03-concurrency-control.md](./03-concurrency-control.md).

---

### ❌ No timeouts on requests

```js
// WRONG: no timeout — hung servers block concurrency slots forever
const { body } = await request(url);
```

**Why it fails:** A single slow or unresponsive server holds a concurrency slot open indefinitely. With N=150 concurrent and 10 hung requests, you're at 93% capacity doing nothing.

**Fix:**
```js
const { body } = await request(url, {
  headersTimeout: 10_000,
  bodyTimeout: 30_000,
});
```

---

### ❌ Accumulating all results in a RAM array

```js
// WRONG: 5000 full HTML pages in memory simultaneously
const allResults = [];
for (const url of urls) {
  allResults.push(await scrape(url)); // grows until OOM
}
fs.writeFileSync('results.json', JSON.stringify(allResults));
```

**Fix:** Write each result to a stream immediately as it arrives. See [04-memory-management.md](./04-memory-management.md).

---

### ❌ Forgetting to raise ulimit

```bash
# Default Linux: 1024 open file descriptors
# 5000 concurrent sockets = EMFILE errors at ~1024
```

**Fix:** `ulimit -n 65536` before starting Node. See [07-os-configuration.md](./07-os-configuration.md).

---

### ❌ Using axios for high-concurrency scraping

**Why it fails:**
- No native connection pooling (each request creates/closes a socket)
- High per-request overhead vs undici
- ECONNRESET errors under heavy concurrency
- Not designed for mass outbound HTTP

**Fix:** Migrate to `undici`. If impossible, add `agentkeepalive`. See [02-http-client.md](./02-http-client.md).

---

### ❌ Using Puppeteer/Playwright for all URLs

**Why it fails:**
- Each Chromium instance: 200–600 MB RAM
- 2 instances = 100% of your RAM budget
- CPU overhead of JS engine × 5000 pages = impossible

**Fix:** Use Puppeteer only for URLs that **require** JavaScript rendering and cannot be scraped with plain HTTP. Separate your URL list into "static" (undici) and "dynamic" (Playwright, max 3–5 concurrent).

---

### ❌ Parsing HTML on the main thread

```js
// WRONG: cheerio.load() is synchronous and CPU-intensive
// Blocks the event loop for every response
const $ = cheerio.load(html);
```

**Fix:** Move all HTML parsing to worker threads. See [05-architecture.md](./05-architecture.md).

---

### ❌ No V8 heap cap

```bash
# WRONG: Node.js default heap can grow to 1.5–4 GB
node scraper.js
```

**Why it fails:** V8 will allocate heap until the OS OOM-killer terminates the process.

**Fix:**
```bash
node --max-old-space-size=700 scraper.js
```

---

### ❌ Using `Promise.all` instead of `Promise.allSettled`

```js
// WRONG: one failure aborts the entire batch
const results = await Promise.all(tasks);
```

**Fix:**
```js
// CORRECT: collects all results including failures
const results = await Promise.allSettled(tasks);
```

---

### ❌ Infinite retry loops

```js
// WRONG: will retry a dead URL forever
while (true) {
  try { return await scrape(url); }
  catch { await sleep(1000); }
}
```

**Fix:** Always cap retries (maxRetries=3). Log failures to a dead letter queue. See [06-resilience.md](./06-resilience.md).

---

## Final Checklist

### Infrastructure

- [ ] `ulimit -n 65536` is set before launching Node
- [ ] `net.ipv4.tcp_tw_reuse = 1` is set in sysctl
- [ ] Node is launched with `--max-old-space-size=700`
- [ ] Node is launched with `--max-semi-space-size=64`
- [ ] `UV_THREADPOOL_SIZE=16` is set (for DNS lookups across many domains)

### HTTP Client

- [ ] Using `undici` (not axios, not node-fetch)
- [ ] `undici.Agent` configured with `connections`, `headersTimeout`, `bodyTimeout`, `connectTimeout`
- [ ] Keep-alive is enabled (undici does this by default)
- [ ] DNS caching is in place for multi-domain scraping

### Concurrency

- [ ] `p-limit` or `Bottleneck` wraps all requests
- [ ] Concurrency N is set to 100–200 (tune empirically)
- [ ] Per-domain rate limiting in place for sites that 429
- [ ] `Promise.allSettled` (not `Promise.all`) used for batches

### Memory

- [ ] Response bodies are streamed, not buffered (where possible)
- [ ] `body.dump()` called on non-200 responses
- [ ] Results written to output stream immediately, not accumulated in array
- [ ] Worker threads handle HTML parsing (not main thread)
- [ ] Memory usage logged every 10–30 seconds during testing

### Resilience

- [ ] `headersTimeout` and `bodyTimeout` set on all requests
- [ ] Retry logic with exponential backoff for retryable errors
- [ ] HTTP 429 handled with Retry-After header respect
- [ ] Circuit breaker per domain to avoid hammering failing hosts
- [ ] Dead letter queue for URLs that exhaust all retries
- [ ] `Promise.allSettled` ensures failures don't abort the batch

### Output

- [ ] Output written to stream (NDJSON or DB) continuously
- [ ] Backpressure applied (wait for `drain` event if write buffer full)
- [ ] Batch DB inserts (500 rows per INSERT, not 1-by-1)
- [ ] Output stream gracefully closed after all tasks complete

---

## Expected Performance on 1 CPU / 1 GB RAM

With all optimizations applied:

| Metric | Expected Value |
|--------|---------------|
| Peak RAM usage | 500–700 MB |
| CPU usage | 10–30% (mostly idle, waiting on I/O) |
| Concurrency | N = 100–200 |
| Throughput | 150–400 req/s |
| Time for 5000 URLs | 15–35 seconds |
| Failure rate (retried) | 5–15% |
| Failure rate (dead letter) | 1–5% |

These numbers assume target servers respond within 500ms on average. Slow servers (2–5s response) will reduce throughput proportionally but the architecture remains stable.
