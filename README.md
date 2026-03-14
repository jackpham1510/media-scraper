# Media Scraper

Media scraper with async job queue, SPA detection, and React gallery.

## Quick Start

```bash
cp .env.example .env
docker compose up --build
```

Open http://localhost in browser.

## Development

```bash
npm install
npm run dev -w packages/api    # API on :3001
npm run dev -w packages/web    # Web on :5173
```

Database:
```bash
npm run db:migrate -w packages/api
npm run db:studio -w packages/api
```

## Load Test

Requires [k6](https://k6.io/docs/get-started/installation/):

```bash
# Start the stack first
docker compose up

# Run load test (5000 concurrent VUs)
k6 run --env API_BASE=http://localhost:3001 load-test/k6-scrape.js
```

Monitor RAM during test:
```bash
docker stats
```

Expected thresholds:
- POST /api/scrape p95 < 500ms under 5000 concurrent clients
- Error rate < 0.5%
- All jobs reach terminal status within 120s
- Peak Node.js container RAM < 580 MB

## SPA Smoke Test

```bash
curl -X POST http://localhost:3001/api/scrape \
  -H 'Content-Type: application/json' \
  -d '{"urls":["https://react.dev","https://vuejs.org","https://angular.io"],"options":{"browserFallback":true}}'
```

Then poll GET /api/scrape/{jobId} and check `urlsSpaDetected: 3`.

## Architecture

- API: Fastify + BullMQ (Node.js, TypeScript strict)
- Scraper: undici + htmlparser2 SAX, p-limit(70) concurrency
- SPA fallback: Playwright Chromium (concurrency 1)
- DB: MySQL 8 + Prisma
- Cache: Redis 7
- Frontend: Vite + React 19 + TanStack Query + Tailwind

See [docs/technical-design.md](docs/technical-design.md) for full architecture.
