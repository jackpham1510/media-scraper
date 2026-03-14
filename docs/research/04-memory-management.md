# 04 — Memory Management, Streaming & GC Tuning

## Memory Budget Breakdown (1 GB Total)

```
Total RAM: 1024 MB
├── OS + system processes:        ~100 MB (reserved, not available)
├── Available to Node.js:         ~924 MB
│   ├── V8 runtime + code cache:  ~80 MB
│   ├── Open TCP sockets (idle):  ~50 KB × N concurrent = varies
│   ├── In-flight response data:  depends on streaming strategy
│   ├── Parsed output buffer:     flush continuously → near zero
│   └── GC headroom (15%):        ~100 MB
│
└── Target: peak usage < 750 MB (leaves 174 MB headroom)
```

### Socket Memory at Different Concurrency Levels

| Concurrency N | Socket Memory | Response Buffers | Total Estimate |
|---------------|--------------|-----------------|----------------|
| 100 | ~5 MB | ~50–200 MB | ~350–450 MB |
| 150 | ~8 MB | ~75–300 MB | ~450–600 MB |
| 200 | ~10 MB | ~100–400 MB | ~600–800 MB |
| 300 | ~15 MB | ~150–600 MB | OOM risk |

> Response buffer range depends entirely on whether you stream or buffer. Streaming reduces this by 80–90%.

---

## Rule #1: Stream, Don't Buffer

The single highest-impact memory optimization. Never read the full body unless necessary.

### ❌ Buffering (dangerous)

```js
// Accumulates the entire response body in RAM before you can process it
const { body } = await request(url);
const html = await body.text();       // full body in RAM
const $ = cheerio.load(html);         // full DOM in RAM
const title = $('title').text();
// Both html and DOM are GC'd only after this scope exits
```

### ✅ SAX Streaming (recommended)

```js
import { request } from 'undici';
import { WritableStream } from 'htmlparser2/lib/WritableStream';

async function scrapeStream(url) {
  const { body, statusCode } = await request(url);

  if (statusCode !== 200) {
    await body.dump(); // consume and discard
    return null;
  }

  return new Promise((resolve, reject) => {
    const data = {};

    const parser = new WritableStream({
      onopentag(name, attrs) {
        if (name === 'meta' && attrs.name === 'description') {
          data.description = attrs.content;
        }
      },
      ontext(text) {
        // Only capture what you need — don't store everything
        if (this._currentTag === 'title') data.title = text;
      },
      onclosetag(name) {
        // React to specific tags, discard the rest
      },
    }, { decodeEntities: true });

    body.pipe(parser)
      .on('finish', () => resolve(data))
      .on('error', reject);
  });
}
```

### ✅ When Buffering Is Acceptable

Buffer the body only when:
- Response is guaranteed < 10 KB (e.g. JSON API endpoints)
- You genuinely need the full DOM (rare)
- The parser requires random access to the document

---

## Rule #2: Dump Bodies You Don't Need

If you get a non-200 response, you still must consume the body — otherwise the socket won't return to the pool.

```js
const { statusCode, body } = await request(url);

if (statusCode !== 200) {
  await body.dump(); // undici: efficiently discards the body
  return { url, error: `HTTP ${statusCode}` };
}
```

---

## Rule #3: Don't Accumulate Results in RAM

```js
// ❌ BAD: all 5000 results held in memory until the end
const allResults = [];
for (const url of urls) {
  const result = await scrape(url);
  allResults.push(result); // grows unboundedly
}
fs.writeFileSync('out.json', JSON.stringify(allResults));

// ✅ GOOD: write each result immediately
const out = fs.createWriteStream('results.ndjson');
for await (const result of scrapeAll(urls)) {
  out.write(JSON.stringify(result) + '\n');
}
```

---

## V8 Heap Configuration

### Cap the Heap Size

By default, V8 may grow the heap to 1.5–4 GB on a 64-bit system — more than your machine has. Explicitly cap it:

```bash
node --max-old-space-size=700 scraper.js
# Leaves ~200 MB for OS + other processes
# V8 will GC more aggressively rather than OOM-killing
```

### Widen the Young Generation (Nursery)

High-concurrency scrapers create massive numbers of short-lived objects (request structs, response chunks, parser state). V8 may prematurely promote them to Old Space, triggering expensive full GC cycles.

```bash
node --max-semi-space-size=64 scraper.js
# Default: 8–16 MB. Wider nursery = fewer premature promotions.
# Cost: slightly higher peak usage during minor GC scavenges.
```

### V8 Pointer Compression (Node 22+)

Halves heap memory usage with no code changes, ~15% faster on I/O-heavy workloads:

```bash
# Node 22+ only — pointer compression is experimental multi-cage
node --max-old-space-size=700 --max-semi-space-size=64 scraper.js
# Pointer compression is ON by default in Node 22 builds
# Check: node -e "process.versions" | grep v8
```

---

## GC Tuning Flags Reference

```bash
node \
  --max-old-space-size=700 \      # heap ceiling in MB
  --max-semi-space-size=64 \      # young gen nursery in MB
  --gc-interval=100 \             # force minor GC every N allocs
  scraper.js
```

| Flag | Value | Effect |
|------|-------|--------|
| `--max-old-space-size` | `700` | Caps heap — prevents OOM-kill |
| `--max-semi-space-size` | `64` | Wider nursery → fewer premature promotions |
| `--gc-interval` | `100` | More frequent minor GCs, lower peak usage |
| `--expose-gc` | — | Enables `global.gc()` for testing/profiling |

---

## Memory Profiling

Monitor memory in production:

```js
// Log memory usage every 10 seconds
setInterval(() => {
  const mem = process.memoryUsage();
  console.log({
    rss:      `${Math.round(mem.rss / 1024 / 1024)} MB`,       // total process memory
    heapUsed: `${Math.round(mem.heapUsed / 1024 / 1024)} MB`,  // V8 heap in use
    heapTotal:`${Math.round(mem.heapTotal / 1024 / 1024)} MB`, // V8 heap allocated
    external: `${Math.round(mem.external / 1024 / 1024)} MB`,  // C++ bindings (sockets)
  });
}, 10_000);
```

If `heapUsed` grows monotonically without leveling off → memory leak. Common causes:
- Event listeners not cleaned up
- Closures capturing large objects
- Results accumulated in module-level arrays
- `domainLimiters` Map growing unboundedly (cap its size)
