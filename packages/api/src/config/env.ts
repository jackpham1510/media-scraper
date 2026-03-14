import { z } from 'zod';

export const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  SCRAPER_CONCURRENCY: z.coerce.number().int().min(1).max(200).default(70),
  QUEUE_MAX_DEPTH: z.coerce.number().int().positive().default(50000),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid environment variables:');
    for (const [field, issues] of Object.entries(result.error.flatten().fieldErrors)) {
      console.error(`  ${field}: ${issues?.join(', ') ?? 'invalid'}`);
    }
    process.exit(1);
  }
  return result.data;
}
