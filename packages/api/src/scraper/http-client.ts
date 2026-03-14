import { Agent, Dispatcher, errors } from 'undici';
import pLimit from 'p-limit';

export const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB

// undici Agent singleton
export const httpAgent = new Agent({
  connections: 10,
  headersTimeout: 10_000,
  bodyTimeout: 30_000,
  connect: {
    timeout: 5_000,
  },
});

// Read SCRAPER_CONCURRENCY from env, default 70 if not set or invalid
function getConcurrency(): number {
  const raw = process.env['SCRAPER_CONCURRENCY'];
  if (raw === undefined) return 70;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed < 1) return 70;
  if (parsed > 200) return 200;
  return parsed;
}

// Process-level singleton limiter — NEVER call pLimit() anywhere else
export const globalLimit = pLimit(getConcurrency());

export type FetchSuccess = {
  status: number;
  headers: Record<string, string>;
  body: Dispatcher.ResponseData['body'];
};

export type FetchError = { error: string };
export type FetchResult = FetchSuccess | FetchError;

export function isFetchError(result: FetchResult): result is FetchError {
  return 'error' in result;
}

/**
 * Fetch a URL using the singleton undici Agent and globalLimit.
 * - Checks Content-Length first; if > MAX_BODY_BYTES, dumps body and returns error.
 * - On non-2xx response, dumps body and returns error.
 */
export async function fetchUrl(url: string): Promise<FetchResult> {
  return globalLimit(async () => {
    const parsed = new URL(url);
    let response: Dispatcher.ResponseData;
    try {
      response = await httpAgent.request({
        origin: parsed.origin,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; MediaScraper/1.0)',
          Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
        headersTimeout: 10_000,
        bodyTimeout: 30_000,
      });
    } catch (err: unknown) {
      if (err instanceof errors.ResponseExceededMaxSizeError) {
        return { error: 'response_too_large' };
      }
      if (err instanceof Error) {
        return { error: err.message };
      }
      return { error: String(err) };
    }

    const { statusCode, headers, body } = response;

    // Check Content-Length before reading body
    const contentLength = headers['content-length'];
    if (contentLength !== undefined && contentLength !== null) {
      const lengthValue = Array.isArray(contentLength) ? contentLength[0] : contentLength;
      if (lengthValue !== undefined && parseInt(lengthValue, 10) > MAX_BODY_BYTES) {
        await body.dump();
        return { error: 'response_too_large' };
      }
    }

    if (statusCode < 200 || statusCode >= 300) {
      await body.dump();
      return { error: `http_${statusCode}` };
    }

    const flatHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined || value === null) continue;
      flatHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
    }

    return { status: statusCode, headers: flatHeaders, body };
  });
}
