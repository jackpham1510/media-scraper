# 02 — HTTP Client Selection & Connection Pooling

## Client Comparison

| Library | Speed | Memory | Verdict |
|---------|-------|--------|---------|
| **undici** | ★★★★★ (20k+ req/s) | ★★★★★ lowest | **Recommended.** Official Node.js HTTP client. 3–5× faster than axios. |
| **got** | ★★★☆☆ | ★★★☆☆ | Good ergonomics, built-in retry, stream support. Use if undici feels low-level. |
| **native fetch** (Node 18+) | ★★★☆☆ | ★★★☆☆ | Powered by undici but with WebStreams overhead. Slower than `undici.request` directly. |
| **axios** | ★★☆☆☆ | ★★☆☆☆ | **Avoid for mass scraping.** No native connection pooling. ECONNRESET under heavy concurrency. |
| **puppeteer / playwright** | ★☆☆☆☆ | ★☆☆☆☆ | **Never for this use case.** 200–600 MB per browser instance. |

> **Rule:** Use `undici.request` directly. At high concurrency it achieves 20,000+ requests per second from a single process and is memory-efficient. If you need interceptors or ergonomics, use `got`.

---

## undici — Recommended Setup

### Basic Agent (Mixed Domains)

Use `Agent` when scraping many different domains. It manages one connection pool per origin automatically.

```js
import { Agent, request } from 'undici';

const agent = new Agent({
  connections: 10,          // max TCP connections per origin
  pipelining: 1,            // HTTP/1.1 pipeline depth (1 = disabled, safe default)
  keepAliveTimeout: 10_000, // ms to keep idle socket alive
  keepAliveMaxTimeout: 30_000,
  connectTimeout: 5_000,    // fail fast on connection
  headersTimeout: 10_000,   // timeout waiting for response headers
  bodyTimeout: 30_000,      // timeout reading response body
});

async function fetchUrl(url) {
  const { statusCode, body } = await request(url, {
    dispatcher: agent,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; MyBot/1.0)',
      'Accept-Encoding': 'gzip, deflate, br',
    },
  });
  return { statusCode, body };
}
```

### Pool (Single Domain, High Volume)

Use `Pool` when hitting many URLs on the same domain. More efficient than Agent for that case.

```js
import { Pool } from 'undici';

const pool = new Pool('https://example.com', {
  connections: 20,      // more connections for single-domain hammering
  pipelining: 2,        // pipeline 2 requests per connection
  keepAliveTimeout: 30_000,
  headersTimeout: 10_000,
  bodyTimeout: 30_000,
});

const { statusCode, body } = await pool.request({
  path: '/page/123',
  method: 'GET',
});
```

---

## Connection Pooling — Why It Matters

Every new TCP connection costs:
- **3-way handshake:** ~0.5–1× round-trip time
- **TLS negotiation (HTTPS):** ~1–2 additional round-trips (~100–200 ms total)

With 5000 URLs and no connection reuse, you pay this cost 5000 times. With pooling and keep-alive, you pay it ~N times (where N = pool size, typically 10–20).

```
Without keep-alive: 5000 × 150ms overhead = 750 seconds of wasted latency
With keep-alive:      20 × 150ms overhead =   3 seconds of wasted latency
```

### agentkeepalive (for axios users who cannot switch)

If you must use axios, at minimum add keep-alive:

```js
import Agent from 'agentkeepalive';
import axios from 'axios';

const keepAliveAgent = new Agent({
  maxSockets: 100,
  maxFreeSockets: 20,
  timeout: 30_000,
  freeSocketTimeout: 15_000,
});

const client = axios.create({
  httpAgent: keepAliveAgent,
  httpsAgent: new Agent.HttpsAgent({ maxSockets: 100 }),
  timeout: 30_000,
});
```

> Even with agentkeepalive, axios has higher per-request overhead than undici. Migrate to undici for any serious scraping workload.

---

## Timeout Configuration

**Never run without timeouts.** A single slow server can permanently occupy a concurrency slot.

| Timeout | Recommended Value | What It Covers |
|---------|------------------|----------------|
| `connectTimeout` | 5 000 ms | TCP connection establishment |
| `headersTimeout` | 10 000 ms | Time to receive first response byte |
| `bodyTimeout` | 30 000 ms | Time to fully read response body |

```js
// undici request with all timeouts
const { statusCode, body } = await request(url, {
  dispatcher: agent,
  headersTimeout: 10_000,
  bodyTimeout: 30_000,
  // connectTimeout is set on the Agent constructor
});
```

---

## HTTP/2 Multiplexing

For domains where you fetch many URLs (e.g. a CDN or large site), HTTP/2 multiplexes multiple requests over a single TCP connection — eliminating head-of-line blocking and reducing connection overhead dramatically.

```js
import { Client } from 'undici';

const client = new Client('https://example.com', {
  allowH2: true,       // enable HTTP/2
  maxConcurrentStreams: 100, // H2 streams per connection
});
```

> Check if the target server supports HTTP/2 with: `curl -I --http2 https://example.com`
