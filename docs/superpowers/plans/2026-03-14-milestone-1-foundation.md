# Milestone 1: Project Foundation & Infrastructure — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the full monorepo skeleton — TypeScript, ESLint, Fastify, Vite+React, Docker Compose (MySQL + Redis + api + web), Prisma schema and migrations — so that `docker compose up` brings all services healthy and `GET /healthz` returns 200.

**Architecture:** Monorepo with `packages/api` (Fastify + BullMQ, TypeScript strict) and `packages/web` (Vite + React 19, TypeScript strict). No business logic yet — purely infra, tooling, and schema. Docker Compose orchestrates four services: MySQL 8, Redis 7, api, web.

**Tech Stack:** Node.js 22, TypeScript 5, Fastify 5, Prisma 5, MySQL 8, Redis 7, Vite 6, React 19, Docker Compose, ESLint 9, Prettier 3.

---

## Chunk 1: Monorepo Root & Shared Tooling

### Files
- Create: `package.json` (root — workspaces)
- Create: `tsconfig.base.json` (shared strict TS config)
- Create: `.eslintrc.cjs` (root ESLint config)
- Create: `.prettierrc` (Prettier config)
- Create: `.gitignore`
- Create: `.env.example`

---

### Task 1: Root package.json with workspaces

**Files:**
- Create: `package.json`

- [ ] **Step 1: Create root package.json**

```json
{
  "name": "media-scraper",
  "private": true,
  "workspaces": [
    "packages/api",
    "packages/web"
  ],
  "engines": {
    "node": ">=22.0.0"
  },
  "scripts": {
    "dev:api": "npm run dev -w packages/api",
    "dev:web": "npm run dev -w packages/web",
    "build": "npm run build -w packages/api && npm run build -w packages/web",
    "typecheck": "npm run typecheck -w packages/api && npm run typecheck -w packages/web",
    "lint": "eslint packages/*/src --ext .ts,.tsx"
  },
  "devDependencies": {
    "@typescript-eslint/eslint-plugin": "^7.0.0",
    "@typescript-eslint/parser": "^7.0.0",
    "eslint": "^9.0.0",
    "prettier": "^3.0.0",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Create shared TypeScript base config**

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

- [ ] **Step 3: Create ESLint config**

`.eslintrc.cjs`:
```js
'use strict';

module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended-type-checked',
  ],
  parserOptions: {
    project: ['./packages/api/tsconfig.json', './packages/web/tsconfig.json'],
  },
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/explicit-function-return-type': 'error',
    '@typescript-eslint/consistent-type-imports': 'error',
  },
};
```

- [ ] **Step 4: Create Prettier config**

`.prettierrc`:
```json
{
  "semi": true,
  "singleQuote": true,
  "tabWidth": 2,
  "trailingComma": "all",
  "printWidth": 100
}
```

- [ ] **Step 5: Create .gitignore**

`.gitignore`:
```
node_modules/
dist/
.env
*.local
.DS_Store
packages/api/prisma/migrations/*.sql.bak
```

- [ ] **Step 6: Create .env.example**

`.env.example`:
```
# Database
DATABASE_URL=mysql://scraper:scraper@localhost:3306/media_scraper

# Redis
REDIS_URL=redis://localhost:6379

# Server
PORT=3001
NODE_ENV=development

# Scraper tuning
SCRAPER_CONCURRENCY=70
QUEUE_MAX_DEPTH=50000

# Rate limiting
RATE_LIMIT_MAX=10
RATE_LIMIT_WINDOW=1m
```

- [ ] **Step 7: Install root devDependencies**

```bash
cd /Users/dungpqt/Projects/media-scraper
npm install
```

Expected: `node_modules/` created at root, no errors.

---

## Chunk 2: API Package — TypeScript + Fastify Skeleton

### Files
- Create: `packages/api/package.json`
- Create: `packages/api/tsconfig.json`
- Create: `packages/api/src/main.ts`
- Create: `packages/api/src/config/env.ts`
- Create: `packages/api/src/routes/health.ts`
- Create: `packages/api/src/types/index.ts`

---

### Task 2: API package.json & tsconfig

**Files:**
- Create: `packages/api/package.json`
- Create: `packages/api/tsconfig.json`

- [ ] **Step 1: Create packages/api directory structure**

```bash
mkdir -p packages/api/src/{config,routes,worker,scraper,db/repositories,types}
```

- [ ] **Step 2: Create packages/api/package.json**

```json
{
  "name": "@media-scraper/api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/main.js",
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "build": "tsc",
    "start": "node dist/main.js",
    "typecheck": "tsc --noEmit",
    "test": "jest --runInBand",
    "db:migrate": "prisma migrate dev",
    "db:generate": "prisma generate",
    "db:studio": "prisma studio"
  },
  "dependencies": {
    "@prisma/client": "^5.11.0",
    "bullmq": "^5.4.0",
    "fastify": "^5.0.0",
    "htmlparser2": "^9.1.0",
    "p-limit": "^5.0.0",
    "pino": "^9.0.0",
    "undici": "^6.11.0",
    "zod": "^3.22.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "jest": "^29.0.0",
    "prisma": "^5.11.0",
    "ts-jest": "^29.0.0",
    "tsx": "^4.7.0"
  }
}
```

- [ ] **Step 3: Create packages/api/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

- [ ] **Step 4: Install API dependencies**

```bash
npm install -w packages/api
```

Expected: dependencies installed, no errors.

---

### Task 3: Environment validation with zod

**Files:**
- Create: `packages/api/src/config/env.ts`

This is the first thing `main.ts` calls. If any required env var is missing, the process exits immediately with a clear message — no silent failures.

- [ ] **Step 1: Write the test first**

`packages/api/src/config/env.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

describe('env config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('parses valid env vars', async () => {
    process.env['DATABASE_URL'] = 'mysql://u:p@localhost:3306/db';
    process.env['REDIS_URL'] = 'redis://localhost:6379';
    process.env['PORT'] = '3001';
    process.env['SCRAPER_CONCURRENCY'] = '70';

    // Re-import to trigger fresh parse
    const { parseEnv } = await import('./env.js');
    const config = parseEnv();
    expect(config.PORT).toBe(3001);
    expect(config.SCRAPER_CONCURRENCY).toBe(70);
  });

  it('applies defaults for optional vars', async () => {
    process.env['DATABASE_URL'] = 'mysql://u:p@localhost:3306/db';
    process.env['REDIS_URL'] = 'redis://localhost:6379';
    delete process.env['PORT'];
    delete process.env['SCRAPER_CONCURRENCY'];

    const { parseEnv } = await import('./env.js');
    const config = parseEnv();
    expect(config.PORT).toBe(3001);
    expect(config.SCRAPER_CONCURRENCY).toBe(70);
    expect(config.RATE_LIMIT_MAX).toBe(10);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL (module not found)**

```bash
npm run test -w packages/api -- --testPathPattern=env
```

Expected: FAIL with "Cannot find module './env.js'"

- [ ] **Step 3: Implement env.ts**

`packages/api/src/config/env.ts`:
```typescript
import { z } from 'zod';

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().url(),

  // Redis
  REDIS_URL: z.string().url(),

  // Server
  PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Scraper
  SCRAPER_CONCURRENCY: z.coerce.number().int().min(1).max(200).default(70),
  QUEUE_MAX_DEPTH: z.coerce.number().int().positive().default(50000),

  // Rate limiting
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_WINDOW: z.string().default('1m'),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Invalid environment variables:');
    for (const [field, issues] of Object.entries(result.error.flatten().fieldErrors)) {
      console.error(`  ${field}: ${issues?.join(', ') ?? 'invalid'}`);
    }
    process.exit(1);
  }
  return result.data;
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npm run test -w packages/api -- --testPathPattern=env
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/config/env.ts packages/api/src/config/env.test.ts
git commit -m "feat(api): add zod env validation with startup exit on missing vars"
```

---

### Task 4: Shared TypeScript types

**Files:**
- Create: `packages/api/src/types/index.ts`

Shared interfaces used across the codebase. Defined once here, never redefined in individual files.

- [ ] **Step 1: Create types/index.ts**

```typescript
// Job status machine: pending → running → fast_complete → done
// fast_complete: fast queue finished, browser queue still has pending URLs
export type JobStatus = 'pending' | 'running' | 'fast_complete' | 'done' | 'failed';

export type UrlStatus = 'pending' | 'processing' | 'spa_detected' | 'done' | 'failed';

export type MediaType = 'image' | 'video';

export type ScrapePath = 'fast' | 'browser';

export interface SpaSignals {
  hasRootDiv: boolean;          // <div id="root|app|__next|__nuxt">
  hasNextData: boolean;         // window.__NEXT_DATA__ in inline script
  hasNuxtData: boolean;         // window.__NUXT__ in inline script
  hasNoScriptWarning: boolean;  // <noscript> contains "enable javascript"
  bodyTextLength: number;       // visible text chars (tags stripped)
  scriptTagCount: number;
  mediaCount: number;           // img + video + source tags with src
}

export interface ParsedPage {
  title: string | null;
  description: string | null;
  mediaItems: Array<{
    mediaUrl: string;
    mediaType: MediaType;
    altText: string | null;
  }>;
  spaSignals: SpaSignals;
}

export interface FastJobPayload {
  jobId: string;
  browserFallback: boolean;
  maxScrollDepth: number;
  urls: Array<{ id: number; url: string }>;
}

export interface BrowserJobPayload {
  jobId: string;
  requestId: number;
  url: string;
  maxScrollDepth: number;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/api/src/types/index.ts
git commit -m "feat(api): add shared TypeScript types for jobs, media, and SPA signals"
```

---

### Task 5: Fastify health check route + main.ts entry point

**Files:**
- Create: `packages/api/src/routes/health.ts`
- Create: `packages/api/src/main.ts`

- [ ] **Step 1: Write the health route test**

`packages/api/src/routes/health.test.ts`:
```typescript
import Fastify from 'fastify';
import { healthRoutes } from './health.js';
import { describe, it, expect, beforeEach } from '@jest/globals';
import type { FastifyInstance } from 'fastify';

describe('GET /healthz', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    await app.register(healthRoutes);
    await app.ready();
  });

  it('returns 200 with status ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npm run test -w packages/api -- --testPathPattern=health
```

Expected: FAIL with "Cannot find module './health.js'"

- [ ] **Step 3: Implement health route**

`packages/api/src/routes/health.ts`:
```typescript
import type { FastifyInstance } from 'fastify';

export async function healthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/healthz', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
          },
          required: ['status'],
        },
      },
    },
  }, async (_request, reply) => {
    return reply.send({ status: 'ok' });
  });
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
npm run test -w packages/api -- --testPathPattern=health
```

Expected: PASS

- [ ] **Step 5: Create main.ts entry point**

`packages/api/src/main.ts`:
```typescript
import Fastify from 'fastify';
import { parseEnv } from './config/env.js';
import { healthRoutes } from './routes/health.js';

const env = parseEnv();

const app = Fastify({
  logger: {
    level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  },
});

await app.register(healthRoutes);

const address = await app.listen({ port: env.PORT, host: '0.0.0.0' });
app.log.info(`Server listening at ${address}`);
```

- [ ] **Step 6: Verify TypeScript compiles**

```bash
npm run typecheck -w packages/api
```

Expected: zero errors.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/routes/health.ts packages/api/src/routes/health.test.ts packages/api/src/main.ts
git commit -m "feat(api): add Fastify skeleton with GET /healthz and typed main entry point"
```

---

## Chunk 3: Web Package — Vite + React Skeleton

### Files
- Create: `packages/web/package.json`
- Create: `packages/web/tsconfig.json`
- Create: `packages/web/tsconfig.node.json`
- Create: `packages/web/vite.config.ts`
- Create: `packages/web/index.html`
- Create: `packages/web/src/main.tsx`
- Create: `packages/web/src/App.tsx`

---

### Task 6: Web package setup

**Files:**
- Create: `packages/web/package.json`
- Create: `packages/web/tsconfig.json`
- Create: `packages/web/tsconfig.node.json`
- Create: `packages/web/vite.config.ts`

- [ ] **Step 1: Create packages/web directory structure**

```bash
mkdir -p packages/web/src/{pages,components,hooks,api}
```

- [ ] **Step 2: Create packages/web/package.json**

```json
{
  "name": "@media-scraper/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@tanstack/react-query": "^5.28.0",
    "axios": "^1.6.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^6.22.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.2.0",
    "autoprefixer": "^10.4.0",
    "postcss": "^8.4.0",
    "tailwindcss": "^4.0.0",
    "vite": "^6.0.0"
  }
}
```

- [ ] **Step 3: Create packages/web/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "noEmit": true
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

- [ ] **Step 4: Create packages/web/tsconfig.node.json**

```json
{
  "compilerOptions": {
    "composite": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true
  },
  "include": ["vite.config.ts"]
}
```

- [ ] **Step 5: Create vite.config.ts**

`packages/web/vite.config.ts`:
```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
```

- [ ] **Step 6: Install web dependencies**

```bash
npm install -w packages/web
```

Expected: no errors.

---

### Task 7: React app skeleton

**Files:**
- Create: `packages/web/index.html`
- Create: `packages/web/src/main.tsx`
- Create: `packages/web/src/App.tsx`

- [ ] **Step 1: Create index.html**

`packages/web/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Media Scraper</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Create src/main.tsx**

`packages/web/src/main.tsx`:
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 5_000,
    },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
```

- [ ] **Step 3: Create src/App.tsx**

`packages/web/src/App.tsx`:
```tsx
export function App(): React.JSX.Element {
  return (
    <div>
      <h1>Media Scraper</h1>
      <p>Coming soon.</p>
    </div>
  );
}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npm run typecheck -w packages/web
```

Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
git add packages/web/
git commit -m "feat(web): add Vite + React 19 skeleton with TanStack Query setup"
```

---

## Chunk 4: Database — Prisma Schema + Migrations

### Files
- Create: `packages/api/prisma/schema.prisma`
- Create: `packages/api/src/db/index.ts`

---

### Task 8: Prisma schema and client

**Files:**
- Create: `packages/api/prisma/schema.prisma`
- Create: `packages/api/src/db/index.ts`

- [ ] **Step 1: Create prisma/schema.prisma**

`packages/api/prisma/schema.prisma`:
```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "mysql"
  url      = env("DATABASE_URL")
}

model ScrapeJob {
  id               String     @id @default(uuid()) @db.VarChar(36)
  status           JobStatus  @default(pending)
  browserFallback  Boolean    @default(false) @map("browser_fallback")
  maxScrollDepth   Int        @default(10) @map("max_scroll_depth") @db.UnsignedTinyInt
  urlsTotal        Int        @default(0) @map("urls_total") @db.UnsignedInt
  urlsDone         Int        @default(0) @map("urls_done") @db.UnsignedInt
  urlsSpaDetected  Int        @default(0) @map("urls_spa_detected") @db.UnsignedInt
  urlsBrowserDone  Int        @default(0) @map("urls_browser_done") @db.UnsignedInt
  createdAt        DateTime   @default(now()) @map("created_at") @db.DateTime(3)
  finishedAt       DateTime?  @map("finished_at") @db.DateTime(3)

  requests         ScrapeRequest[]
  pages            ScrapePage[]
  mediaItems       MediaItem[]

  @@index([status], name: "idx_status")
  @@index([createdAt], name: "idx_created_at")
  @@map("scrape_jobs")
}

model ScrapeRequest {
  id          BigInt       @id @default(autoincrement()) @db.UnsignedBigInt
  jobId       String       @map("job_id") @db.VarChar(36)
  url         String       @db.Text
  status      UrlStatus    @default(pending)
  scrapePath  ScrapePath?  @map("scrape_path")
  spaScore    Int?         @map("spa_score") @db.UnsignedTinyInt
  error       String?      @db.Text

  job         ScrapeJob    @relation(fields: [jobId], references: [id], onDelete: Cascade)

  @@index([jobId, status], name: "idx_job_status")
  @@index([jobId, scrapePath], name: "idx_job_path")
  @@map("scrape_requests")
}

model ScrapePage {
  id          BigInt      @id @default(autoincrement()) @db.UnsignedBigInt
  jobId       String      @map("job_id") @db.VarChar(36)
  sourceUrl   String      @map("source_url") @db.VarChar(2048)
  title       String?     @db.VarChar(1000)
  description String?     @db.Text
  scrapedAt   DateTime    @default(now()) @map("scraped_at") @db.DateTime(3)

  job         ScrapeJob   @relation(fields: [jobId], references: [id], onDelete: Cascade)
  mediaItems  MediaItem[]

  @@index([jobId], name: "idx_job_id")
  @@index([sourceUrl(255)], name: "idx_source_url")
  @@map("scrape_pages")
}

model MediaItem {
  id            BigInt      @id @default(autoincrement()) @db.UnsignedBigInt
  pageId        BigInt      @map("page_id") @db.UnsignedBigInt
  jobId         String      @map("job_id") @db.VarChar(36)
  sourceUrl     String      @map("source_url") @db.VarChar(2048)
  mediaUrl      String      @map("media_url") @db.VarChar(2048)
  mediaUrlHash  String      @map("media_url_hash") @db.Char(64)
  mediaType     MediaType   @map("media_type")
  altText       String?     @map("alt_text") @db.VarChar(1000)
  createdAt     DateTime    @default(now()) @map("created_at") @db.DateTime(3)

  page          ScrapePage  @relation(fields: [pageId], references: [id], onDelete: Cascade)
  job           ScrapeJob   @relation(fields: [jobId], references: [id], onDelete: Cascade)

  @@unique([mediaUrlHash], name: "uq_media_url_hash")
  @@index([jobId], name: "idx_job_id")
  @@index([mediaType], name: "idx_media_type")
  @@index([createdAt], name: "idx_created_at")
  @@map("media_items")
}

enum JobStatus {
  pending
  running
  fast_complete
  done
  failed
}

enum UrlStatus {
  pending
  processing
  spa_detected
  done
  failed
}

enum MediaType {
  image
  video
}

enum ScrapePath {
  fast
  browser
}
```

**Note on FULLTEXT index:** Prisma does not support `@@fulltext` for the `alt_text` column natively in the schema itself (it's supported via `@@fulltext` annotation only in MongoDB). We'll add it in a SQL migration file after `prisma migrate dev` generates the initial migration.

- [ ] **Step 2: Create db/index.ts — Prisma client singleton**

`packages/api/src/db/index.ts`:
```typescript
import { PrismaClient } from '@prisma/client';

// Single Prisma client instance for the process lifetime.
// Importing this from other modules reuses the same connection pool.
export const db = new PrismaClient({
  log: process.env['NODE_ENV'] === 'development' ? ['warn', 'error'] : ['error'],
});
```

- [ ] **Step 3: Generate Prisma client (requires MySQL running)**

This step requires the MySQL container to be running. Skip and come back after Docker Compose is set up (Task 10), or run with a local MySQL instance if available.

```bash
# After MySQL is available:
DATABASE_URL="mysql://scraper:scraper@localhost:3306/media_scraper" \
  npm run db:migrate -w packages/api -- --name init
```

Expected: migration files created in `packages/api/prisma/migrations/`

- [ ] **Step 4: Add FULLTEXT index to the generated migration**

After `prisma migrate dev` generates `packages/api/prisma/migrations/<timestamp>_init/migration.sql`, append this at the end of the file:

```sql
-- FULLTEXT index for media search on alt_text
-- Raw SQL required: Prisma schema DSL does not support FULLTEXT index syntax
ALTER TABLE `media_items` ADD FULLTEXT INDEX `idx_ft_search` (`alt_text`);
```

- [ ] **Step 5: Commit**

```bash
git add packages/api/prisma/ packages/api/src/db/index.ts
git commit -m "feat(api): add Prisma schema with all 4 tables and FULLTEXT migration"
```

---

## Chunk 5: Docker Compose

### Files
- Create: `docker-compose.yml`
- Create: `docker-compose.prod.yml`
- Create: `packages/api/Dockerfile`
- Create: `packages/web/Dockerfile`
- Create: `packages/api/mysql.cnf`

---

### Task 9: MySQL tuning config

**Files:**
- Create: `packages/api/mysql.cnf`

MySQL default `innodb_buffer_pool_size` is 128M × 5 = 640MB — far too high for 1 GB RAM. We must override it.

- [ ] **Step 1: Create MySQL config override**

`mysql.cnf` (at repo root, mounted into container):
```ini
[mysqld]
innodb_buffer_pool_size = 256M
innodb_log_file_size    = 64M
max_connections         = 100
```

---

### Task 10: docker-compose.yml

**Files:**
- Create: `docker-compose.yml`

- [ ] **Step 1: Create docker-compose.yml**

```yaml
version: '3.9'

services:
  mysql:
    image: mysql:8.0
    restart: unless-stopped
    environment:
      MYSQL_ROOT_PASSWORD: rootpassword
      MYSQL_DATABASE: media_scraper
      MYSQL_USER: scraper
      MYSQL_PASSWORD: scraper
    volumes:
      - mysql_data:/var/lib/mysql
      - ./mysql.cnf:/etc/mysql/conf.d/tuning.cnf:ro
    ports:
      - '3306:3306'
    healthcheck:
      test: ['CMD', 'mysqladmin', 'ping', '-h', 'localhost', '-u', 'scraper', '-pscraper']
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 30s

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    ports:
      - '6379:6379'
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 3s
      retries: 5

  api:
    build:
      context: .
      dockerfile: packages/api/Dockerfile
    restart: unless-stopped
    depends_on:
      mysql:
        condition: service_healthy
      redis:
        condition: service_healthy
    environment:
      DATABASE_URL: mysql://scraper:scraper@mysql:3306/media_scraper
      REDIS_URL: redis://redis:6379
      PORT: 3001
      NODE_ENV: production
      SCRAPER_CONCURRENCY: 70
      QUEUE_MAX_DEPTH: 50000
      RATE_LIMIT_MAX: 10
      RATE_LIMIT_WINDOW: 1m
    ports:
      - '3001:3001'
    ulimits:
      nofile:
        soft: 65536
        hard: 65536
    deploy:
      resources:
        limits:
          memory: 580m
    healthcheck:
      test: ['CMD', 'wget', '-qO-', 'http://localhost:3001/healthz']
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 15s

  web:
    build:
      context: .
      dockerfile: packages/web/Dockerfile
    restart: unless-stopped
    depends_on:
      api:
        condition: service_healthy
    ports:
      - '80:80'
    healthcheck:
      test: ['CMD', 'wget', '-qO-', 'http://localhost:80']
      interval: 10s
      timeout: 5s
      retries: 3

volumes:
  mysql_data:
```

---

### Task 11: Dockerfiles

**Files:**
- Create: `packages/api/Dockerfile`
- Create: `packages/web/Dockerfile`

- [ ] **Step 1: Create API Dockerfile**

`packages/api/Dockerfile`:
```dockerfile
# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copy workspace manifests
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/api/package.json ./packages/api/
COPY packages/web/package.json ./packages/web/

# Install all deps (needed for workspace hoisting)
RUN npm ci

# Copy API source
COPY packages/api ./packages/api

# Generate Prisma client
RUN npx prisma generate --schema packages/api/prisma/schema.prisma

# Build TypeScript
RUN npm run build -w packages/api

# Production stage
FROM node:22-alpine AS runner

WORKDIR /app

# Install production deps only
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/api/package.json ./packages/api/
COPY packages/web/package.json ./packages/web/
RUN npm ci --omit=dev

# Copy built output and prisma
COPY --from=builder /app/packages/api/dist ./packages/api/dist
COPY --from=builder /app/packages/api/prisma ./packages/api/prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# Run migrations then start (migrations are idempotent — safe on every start)
CMD ["sh", "-c", "npx prisma migrate deploy --schema packages/api/prisma/schema.prisma && node --max-old-space-size=480 --max-semi-space-size=64 packages/api/dist/main.js"]

ENV UV_THREADPOOL_SIZE=16
ENV NODE_OPTIONS="--max-old-space-size=480 --max-semi-space-size=64"
```

- [ ] **Step 2: Create web Dockerfile**

`packages/web/Dockerfile`:
```dockerfile
# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/api/package.json ./packages/api/
COPY packages/web/package.json ./packages/web/
RUN npm ci

COPY packages/web ./packages/web

RUN npm run build -w packages/web

# Serve with nginx
FROM nginx:alpine AS runner

COPY --from=builder /app/packages/web/dist /usr/share/nginx/html

# nginx config: serve SPA with fallback to index.html, proxy /api to api service
COPY packages/web/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
```

- [ ] **Step 3: Create nginx config for SPA routing**

`packages/web/nginx.conf`:
```nginx
server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    # Serve static assets
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Proxy API requests to the api service
    location /api/ {
        proxy_pass http://api:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # Gzip
    gzip on;
    gzip_types text/plain text/css application/json application/javascript;
}
```

- [ ] **Step 4: Create docker-compose.prod.yml**

`docker-compose.prod.yml`:
```yaml
version: '3.9'

# Overlays docker-compose.yml with production resource limits.
# Usage: docker compose -f docker-compose.yml -f docker-compose.prod.yml up

services:
  api:
    deploy:
      resources:
        limits:
          memory: 580m
          cpus: '1.0'
    ulimits:
      nofile:
        soft: 65536
        hard: 65536
    environment:
      NODE_ENV: production

  mysql:
    deploy:
      resources:
        limits:
          memory: 300m

  redis:
    deploy:
      resources:
        limits:
          memory: 60m
```

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml docker-compose.prod.yml mysql.cnf \
  packages/api/Dockerfile packages/web/Dockerfile packages/web/nginx.conf
git commit -m "feat: add Docker Compose with MySQL, Redis, api, web — all with health checks"
```

---

## Chunk 6: Jest Setup & Final Verification

### Files
- Create: `packages/api/jest.config.ts`

---

### Task 12: Jest configuration

**Files:**
- Create: `packages/api/jest.config.ts`

- [ ] **Step 1: Create jest.config.ts**

`packages/api/jest.config.ts`:
```typescript
import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      useESM: true,
      tsconfig: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
      },
    }],
  },
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts', '!src/db/index.ts'],
  coverageThreshold: {
    global: {
      lines: 80,
    },
  },
};

export default config;
```

- [ ] **Step 2: Run all tests**

```bash
npm run test -w packages/api
```

Expected: all tests PASS (env.test.ts, health.test.ts).

---

### Task 13: End-to-end Docker Compose verification

This is the Milestone 1 done criteria check.

- [ ] **Step 1: Build and start all services**

```bash
docker compose up --build -d
```

Expected: all 4 services start, no build errors.

- [ ] **Step 2: Wait for health checks**

```bash
docker compose ps
```

Expected: all services show `healthy` (may take 30–60s for MySQL first boot).

- [ ] **Step 3: Verify GET /healthz**

```bash
curl -s http://localhost:3001/healthz
```

Expected:
```json
{"status":"ok"}
```

- [ ] **Step 4: Verify TypeScript compiles across both packages**

```bash
npm run typecheck
```

Expected: zero errors from both `packages/api` and `packages/web`.

- [ ] **Step 5: Verify MySQL migration ran**

```bash
docker compose exec mysql mysql -u scraper -pscraper media_scraper -e "SHOW TABLES;"
```

Expected:
```
+----------------------------+
| Tables_in_media_scraper    |
+----------------------------+
| _prisma_migrations         |
| media_items                |
| scrape_jobs                |
| scrape_pages               |
| scrape_requests            |
+----------------------------+
```

- [ ] **Step 6: Final commit**

```bash
git add .
git commit -m "feat: complete Milestone 1 — monorepo, TypeScript, Docker, Prisma schema verified"
```

---

## Done Criteria Checklist (from execution-plan.md)

- [ ] `docker compose up` starts all services cleanly (all show `healthy`)
- [ ] `GET /healthz` returns 200 `{ "status": "ok" }`
- [ ] Prisma migrations run successfully on MySQL — all 4 tables created
- [ ] TypeScript compiles with zero errors (`npm run typecheck`)
- [ ] All unit tests pass (`npm run test -w packages/api`)
- [ ] ESLint passes with zero warnings (`npm run lint`)
