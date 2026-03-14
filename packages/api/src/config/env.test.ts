import { describe, it, expect } from '@jest/globals';
import { envSchema } from './env.js';

describe('envSchema', () => {
  it('parses valid required env vars', () => {
    const result = envSchema.safeParse({
      DATABASE_URL: 'mysql://u:p@localhost:3306/db',
      REDIS_URL: 'redis://localhost:6379',
      PORT: '3001',
      SCRAPER_CONCURRENCY: '70',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.PORT).toBe(3001);
      expect(result.data.SCRAPER_CONCURRENCY).toBe(70);
    }
  });

  it('applies defaults for optional vars', () => {
    const result = envSchema.safeParse({
      DATABASE_URL: 'mysql://u:p@localhost:3306/db',
      REDIS_URL: 'redis://localhost:6379',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.PORT).toBe(3001);
      expect(result.data.SCRAPER_CONCURRENCY).toBe(70);
      expect(result.data.RATE_LIMIT_MAX).toBe(10);
    }
  });

  it('rejects missing required vars', () => {
    const result = envSchema.safeParse({
      REDIS_URL: 'redis://localhost:6379',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid URL', () => {
    const result = envSchema.safeParse({
      DATABASE_URL: 'not-a-url',
      REDIS_URL: 'redis://localhost:6379',
    });
    expect(result.success).toBe(false);
  });
});
