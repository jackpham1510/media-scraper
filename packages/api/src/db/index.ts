import { PrismaClient } from '@prisma/client';

// Single Prisma client instance for the process lifetime.
// All DB access goes through repositories — import `db` there, not here directly in routes.
export const db = new PrismaClient({
  log: process.env['NODE_ENV'] === 'development' ? ['warn', 'error'] : ['error'],
});
