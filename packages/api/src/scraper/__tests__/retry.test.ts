import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { withRetry, NonRetryableError } from '../retry.js';

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

function makeNetworkError(code: string): Error {
  const err = new Error(`Network error: ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function makeHttpError(status: number): Error {
  return new Error(`http_${status}`);
}

function mockFn(): jest.MockedFunction<() => Promise<unknown>> {
  return jest.fn<() => Promise<unknown>>();
}

describe('withRetry', () => {
  it('returns result on first success without retrying', async () => {
    const fn = mockFn().mockResolvedValue('success');
    const result = await withRetry(fn);
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on ECONNRESET and succeeds on second attempt', async () => {
    const fn = mockFn()
      .mockRejectedValueOnce(makeNetworkError('ECONNRESET'))
      .mockResolvedValue('ok');

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 100 });
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on ETIMEDOUT', async () => {
    const fn = mockFn()
      .mockRejectedValueOnce(makeNetworkError('ETIMEDOUT'))
      .mockRejectedValueOnce(makeNetworkError('ETIMEDOUT'))
      .mockResolvedValue('done');

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 100 });
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('done');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('retries on ECONNREFUSED', async () => {
    const fn = mockFn()
      .mockRejectedValueOnce(makeNetworkError('ECONNREFUSED'))
      .mockResolvedValue('connected');

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 100 });
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('connected');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on 404', async () => {
    const fn = mockFn().mockRejectedValue(makeHttpError(404));
    await expect(withRetry(fn)).rejects.toThrow('http_404');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on 403', async () => {
    const fn = mockFn().mockRejectedValue(makeHttpError(403));
    await expect(withRetry(fn)).rejects.toThrow('http_403');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on 401', async () => {
    const fn = mockFn().mockRejectedValue(makeHttpError(401));
    await expect(withRetry(fn)).rejects.toThrow('http_401');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on 400', async () => {
    const fn = mockFn().mockRejectedValue(makeHttpError(400));
    await expect(withRetry(fn)).rejects.toThrow('http_400');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on 429', async () => {
    const fn = mockFn()
      .mockRejectedValueOnce(makeHttpError(429))
      .mockResolvedValue('rate-limited-then-ok');

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 100 });
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('rate-limited-then-ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on 500', async () => {
    const fn = mockFn()
      .mockRejectedValueOnce(makeHttpError(500))
      .mockResolvedValue('recovered');

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 100 });
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('respects max 3 retries and throws after exhausting', async () => {
    const err = makeNetworkError('ECONNRESET');
    const fn = mockFn().mockRejectedValue(err);

    const assertion = expect(
      withRetry(fn, { maxRetries: 3, baseDelayMs: 10 }),
    ).rejects.toThrow('ECONNRESET');
    await jest.runAllTimersAsync();
    await assertion;

    // 1 initial + 3 retries = 4 total calls
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('throws immediately on NonRetryableError', async () => {
    const fn = mockFn().mockRejectedValue(new NonRetryableError('not retryable'));
    await expect(withRetry(fn)).rejects.toThrow('not retryable');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on TLS errors', async () => {
    const tlsErr = new Error('certificate verify failed');
    const fn = mockFn().mockRejectedValue(tlsErr);
    await expect(withRetry(fn)).rejects.toThrow('certificate');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
