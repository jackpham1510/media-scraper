# 06 — Resilience: Retry, Circuit Breaker & Timeout Strategy

## Expected Failure Rates

At 5000 URLs scraped from the public internet, expect:

| Error Type | Typical Rate | Cause |
|------------|-------------|-------|
| ECONNRESET / ECONNREFUSED | 2–5% | Remote server closed connection |
| ETIMEDOUT | 1–3% | Server too slow, firewall dropping packets |
| HTTP 429 | 1–10% | Rate limiting by target site |
| HTTP 5xx | 1–3% | Target server errors |
| HTTP 404/410 | 5–15% | Dead URLs (expected, don't retry) |
| TLS errors | 0.5–1% | Expired/misconfigured certificates |

Total retryable failures: typically **5–20%** of URLs. Your scraper must handle this gracefully without crashing or consuming all concurrency slots forever.

---

## Retry Strategy

### Basic Exponential Backoff

```js
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'UND_ERR_SOCKET']);
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

async function scrapeWithRetry(url, options = {}) {
  const {
    maxRetries = 3,
    baseDelay = 1000,    // ms
    maxDelay = 30_000,   // ms
    timeout = { headersTimeout: 10_000, bodyTimeout: 30_000 },
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const { statusCode, body } = await request(url, {
        dispatcher: agent,
        ...timeout,
      });

      // Non-retryable HTTP errors (404, 403, etc.)
      if (!RETRYABLE_STATUS.has(statusCode) && statusCode >= 400) {
        await body.dump();
        return { url, statusCode, error: `HTTP ${statusCode}`, retries: attempt };
      }

      // Success or retryable HTTP status
      if (!RETRYABLE_STATUS.has(statusCode)) {
        const html = await body.text();
        return { url, statusCode, html, retries: attempt };
      }

      // Retryable HTTP status (429, 5xx)
      await body.dump();
      lastError = new Error(`HTTP ${statusCode}`);
      lastError.statusCode = statusCode;

      // Respect Retry-After header for 429
      if (statusCode === 429) {
        const retryAfter = parseInt(headers['retry-after'] ?? '5', 10);
        await sleep(retryAfter * 1000);
        continue; // don't apply backoff on top of Retry-After
      }

    } catch (err) {
      // Non-retryable network errors
      if (!RETRYABLE_CODES.has(err.code) && !RETRYABLE_CODES.has(err.cause?.code)) {
        return { url, statusCode: null, html: null, error: err.message, retries: attempt };
      }
      lastError = err;
    }

    if (attempt < maxRetries) {
      // Exponential backoff with jitter
      const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
      const jitter = Math.random() * delay * 0.3; // ±30% jitter
      await sleep(delay + jitter);
    }
  }

  return {
    url,
    statusCode: lastError?.statusCode ?? null,
    html: null,
    error: `Max retries exceeded: ${lastError?.message}`,
    retries: maxRetries,
  };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
```

---

## Per-Domain Circuit Breaker

Prevent hammering a failing domain with retries across all in-flight requests:

```js
class CircuitBreaker {
  constructor({ threshold = 5, resetTimeout = 30_000 } = {}) {
    this.failures = new Map();  // domain → { count, openedAt }
    this.threshold = threshold;
    this.resetTimeout = resetTimeout;
  }

  isOpen(domain) {
    const state = this.failures.get(domain);
    if (!state) return false;
    if (Date.now() - state.openedAt > this.resetTimeout) {
      this.failures.delete(domain); // half-open: allow retry
      return false;
    }
    return state.count >= this.threshold;
  }

  recordFailure(domain) {
    const state = this.failures.get(domain) ?? { count: 0, openedAt: Date.now() };
    state.count++;
    if (state.count === 1) state.openedAt = Date.now(); // reset timer on first failure
    this.failures.set(domain, state);
  }

  recordSuccess(domain) {
    this.failures.delete(domain);
  }
}

const breaker = new CircuitBreaker({ threshold: 10, resetTimeout: 60_000 });

async function scrapeWithBreaker(url) {
  const domain = new URL(url).hostname;

  if (breaker.isOpen(domain)) {
    return { url, error: `Circuit open for ${domain}`, skipped: true };
  }

  try {
    const result = await scrapeWithRetry(url);
    if (!result.error) breaker.recordSuccess(domain);
    else breaker.recordFailure(domain);
    return result;
  } catch (err) {
    breaker.recordFailure(domain);
    throw err;
  }
}
```

---

## Timeout Hierarchy

Set timeouts at three levels, each protecting a different failure mode:

```
1. Connect timeout (5s)
   └── Protects against: firewall drops, unreachable hosts
       If exceeded: ETIMEDOUT immediately, no socket consumed

2. Headers timeout (10s)
   └── Protects against: slow servers that accept connection but never send headers
       If exceeded: connection closed, socket returned to pool

3. Body timeout (30s)
   └── Protects against: servers that send headers but drip-feed the body
       If exceeded: body read aborted, socket returned to pool

4. Global task timeout (optional, 45s)
   └── Protects against: any unexpected hang in your own code
       Wraps the entire scrapeOne() call
```

```js
import { setTimeout as setTimeoutAsync } from 'timers/promises';

async function withTimeout(promise, ms, url) {
  const timer = setTimeoutAsync(ms, 'timeout');
  const result = await Promise.race([
    promise,
    timer.then(() => { throw new Error(`Task timeout after ${ms}ms: ${url}`); }),
  ]);
  timer.cancel?.(); // Node 20+: cancel the timer if promise won
  return result;
}

// Usage
const result = await withTimeout(scrapeOne(url), 45_000, url);
```

---

## Handling HTTP 429 (Rate Limiting)

```js
async function scrapeRespectingRateLimits(url) {
  const { statusCode, headers, body } = await request(url, { dispatcher: agent });

  if (statusCode === 429) {
    await body.dump();

    // Parse Retry-After (seconds or HTTP-date)
    const retryAfter = headers['retry-after'];
    let waitMs = 5000; // default 5s

    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10);
      if (!isNaN(seconds)) {
        waitMs = seconds * 1000;
      } else {
        // HTTP-date format
        const retryDate = new Date(retryAfter).getTime();
        waitMs = Math.max(0, retryDate - Date.now());
      }
    }

    console.warn(`Rate limited by ${new URL(url).hostname}. Waiting ${waitMs}ms`);
    await sleep(waitMs);
    return scrapeRespectingRateLimits(url); // retry once
  }

  return { statusCode, body };
}
```

---

## Dead Letter Queue

URLs that fail all retries should go to a dead letter queue for manual inspection, not silently dropped:

```js
import { createWriteStream } from 'fs';

const deadLetter = createWriteStream('failed-urls.ndjson');

async function scrapeWithDLQ(url) {
  const result = await scrapeWithRetry(url);
  if (result.error) {
    deadLetter.write(JSON.stringify({
      url,
      error: result.error,
      retries: result.retries,
      timestamp: new Date().toISOString(),
    }) + '\n');
  }
  return result;
}
```

After the main run, the failed URLs file can be re-processed with adjusted settings.
