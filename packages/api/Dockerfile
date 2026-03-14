# syntax=docker/dockerfile:1
FROM node:22-alpine AS builder

WORKDIR /app

# Copy workspace manifests first (layer caching)
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/api/package.json ./packages/api/
COPY packages/web/package.json ./packages/web/

RUN npm ci

# Copy API source
COPY packages/api ./packages/api

# Generate Prisma client
RUN npx prisma generate --schema packages/api/prisma/schema.prisma

# Build TypeScript
RUN npm run build -w packages/api

# ---
FROM node:22-alpine AS runner

WORKDIR /app

# Production deps only
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/api/package.json ./packages/api/
COPY packages/web/package.json ./packages/web/
RUN npm ci --omit=dev

# Copy compiled output + Prisma artifacts
COPY --from=builder /app/packages/api/dist ./packages/api/dist
COPY --from=builder /app/packages/api/prisma ./packages/api/prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

ENV UV_THREADPOOL_SIZE=16
ENV NODE_OPTIONS="--max-old-space-size=480 --max-semi-space-size=64"

# Run migrations then start (prisma migrate deploy is idempotent)
CMD ["sh", "-c", "npx prisma migrate deploy --schema packages/api/prisma/schema.prisma && node packages/api/dist/main.js"]
