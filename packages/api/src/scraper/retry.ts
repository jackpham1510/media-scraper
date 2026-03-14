export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
}

export class NonRetryableError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'UND_ERR_SOCKET',
]);

const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);

const NON_RETRYABLE_HTTP_STATUSES = new Set([400, 401, 403, 404]);

function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  // Check error codes
  const code = (err as NodeJS.ErrnoException).code;
  if (code !== undefined && RETRYABLE_ERROR_CODES.has(code)) return true;

  // Check for TLS errors (non-retryable)
  const message = err.message.toLowerCase();
  if (
    message.includes('certificate') ||
    message.includes('ssl') ||
    message.includes('tls') ||
    message.includes('handshake')
  ) {
    return false;
  }

  // Check undici error names
  if (err.constructor.name === 'UND_ERR_SOCKET') return true;

  return false;
}

function getRetryAfterMs(err: unknown): number | null {
  if (err instanceof Error && 'retryAfter' in err) {
    const retryAfter = (err as Error & { retryAfter?: unknown }).retryAfter;
    if (typeof retryAfter === 'number') return retryAfter * 1000;
    if (typeof retryAfter === 'string') {
      const parsed = parseInt(retryAfter, 10);
      if (!isNaN(parsed)) return parsed * 1000;
    }
  }
  return null;
}

function isRetryableHttpError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message;

  // Check for http_NNN error format from fetchUrl
  const httpMatch = /^http_(\d+)$/.exec(message);
  if (httpMatch !== null && httpMatch[1] !== undefined) {
    const status = parseInt(httpMatch[1], 10);
    if (NON_RETRYABLE_HTTP_STATUSES.has(status)) return false;
    if (RETRYABLE_HTTP_STATUSES.has(status)) return true;
  }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff and ±30% jitter.
 * Retries on retryable errors only. Throws on non-retryable errors immediately.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1000;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;

      // Non-retryable errors: throw immediately
      if (err instanceof NonRetryableError) throw err;

      const isHttpRetryable = isRetryableHttpError(err);
      const isNetworkRetryable = isRetryableError(err);

      if (!isHttpRetryable && !isNetworkRetryable) {
        throw err;
      }

      // Last attempt — don't sleep, just throw
      if (attempt === maxRetries) break;

      // Honor Retry-After header for 429s
      const retryAfterMs = getRetryAfterMs(err);
      let delayMs: number;
      if (retryAfterMs !== null) {
        delayMs = retryAfterMs;
      } else {
        // Exponential backoff with ±30% jitter
        const exponential = baseDelayMs * Math.pow(2, attempt);
        const jitter = exponential * 0.3 * (Math.random() * 2 - 1);
        delayMs = Math.max(0, exponential + jitter);
      }

      await sleep(delayMs);
    }
  }

  throw lastError;
}
