# syntax=docker/dockerfile:1
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/api/package.json ./packages/api/
COPY packages/web/package.json ./packages/web/
RUN npm ci

COPY packages/web ./packages/web

RUN npm run build -w packages/web

# ---
FROM nginx:alpine AS runner

COPY --from=builder /app/packages/web/dist /usr/share/nginx/html
COPY packages/web/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
