# Node.js High-Concurrency Scraper — 5000 URLs on 1 CPU / 1 GB RAM

## Overview

This guide covers the architecture, best practices, and implementation strategies for scraping 5000 URLs concurrently on a constrained single-CPU, 1 GB RAM machine using Node.js.

**Core insight:** This is not a CPU or RAM problem — it is an I/O concurrency design problem. Node.js's non-blocking event loop handles thousands of outstanding sockets asynchronously on a single thread, sitting nearly idle while remote servers respond.

## Document Index

| File | Contents |
|------|----------|
| [01-fundamentals.md](./01-fundamentals.md) | Why this is feasible, event loop model, constraint analysis |
| [02-http-client.md](./02-http-client.md) | HTTP client selection, undici, connection pooling |
| [03-concurrency-control.md](./03-concurrency-control.md) | p-limit, Bottleneck, queue-based design, backpressure |
| [04-memory-management.md](./04-memory-management.md) | Memory budget, streaming, GC tuning, V8 flags |
| [05-architecture.md](./05-architecture.md) | System architecture, worker threads, output sinks |
| [06-resilience.md](./06-resilience.md) | Retry logic, circuit breaker, timeout strategy |
| [07-os-configuration.md](./07-os-configuration.md) | ulimit, kernel TCP settings, process launch flags |
| [08-pitfalls-and-checklist.md](./08-pitfalls-and-checklist.md) | Common pitfalls, anti-patterns, final checklist |

## Quick-Start Decision Tree

```
Are responses JS-rendered (SPA, lazy-load)?
├── YES → Use Puppeteer/Playwright, max 3–5 concurrent (200 MB/instance)
└── NO  → Use undici HTTP client (plain HTML or JSON API)
           └── Set concurrency N via p-limit
                ├── Pages < 10 KB  → N = 200–300
                ├── Pages 10–100 KB → N = 100–150
                └── Pages > 100 KB  → N = 50–100
```

## Estimated Throughput (1 CPU / 1 GB)

| Concurrency N | Avg Latency | Throughput | Peak RAM |
|---------------|-------------|------------|----------|
| 100 | 500 ms | ~200 req/s | ~400 MB |
| 150 | 500 ms | ~300 req/s | ~550 MB |
| 200 | 500 ms | ~400 req/s | ~750 MB |
| 150 | 1000 ms | ~150 req/s | ~500 MB |

At N=150 and 500 ms average latency, all 5000 URLs complete in approximately **17–25 seconds**.
