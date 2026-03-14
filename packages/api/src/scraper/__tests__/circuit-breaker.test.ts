import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { circuitBreaker } from '../circuit-breaker.js';

describe('CircuitBreaker', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // Reset internal state between tests by recording successes or just rely on domain isolation
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('allows requests when no failures recorded', () => {
    expect(circuitBreaker.canRequest('fresh-domain.com')).toBe(true);
  });

  it('allows requests after fewer than 10 failures', () => {
    const domain = 'few-failures.com';
    for (let i = 0; i < 9; i++) {
      circuitBreaker.recordFailure(domain);
    }
    expect(circuitBreaker.canRequest(domain)).toBe(true);
  });

  it('trips (canRequest returns false) after exactly 10 failures', () => {
    const domain = 'tripped-domain.com';
    for (let i = 0; i < 10; i++) {
      circuitBreaker.recordFailure(domain);
    }
    expect(circuitBreaker.canRequest(domain)).toBe(false);
  });

  it('remains tripped after 11 failures', () => {
    const domain = 'eleven-failures.com';
    for (let i = 0; i < 11; i++) {
      circuitBreaker.recordFailure(domain);
    }
    expect(circuitBreaker.canRequest(domain)).toBe(false);
  });

  it('resets after 60 seconds and allows requests again', () => {
    const domain = 'reset-after-60s.com';
    for (let i = 0; i < 10; i++) {
      circuitBreaker.recordFailure(domain);
    }
    expect(circuitBreaker.canRequest(domain)).toBe(false);

    // Advance system time by 60 seconds
    jest.setSystemTime(Date.now() + 60_000);

    expect(circuitBreaker.canRequest(domain)).toBe(true);
  });

  it('does NOT reset before 60 seconds have elapsed', () => {
    const domain = 'not-reset-yet.com';
    for (let i = 0; i < 10; i++) {
      circuitBreaker.recordFailure(domain);
    }
    expect(circuitBreaker.canRequest(domain)).toBe(false);

    // Advance system time by 59 seconds — should still be tripped
    jest.setSystemTime(Date.now() + 59_000);

    expect(circuitBreaker.canRequest(domain)).toBe(false);
  });

  it('isolates failures per domain', () => {
    const trippedDomain = 'tripped.example.com';
    const cleanDomain = 'clean.example.com';

    for (let i = 0; i < 10; i++) {
      circuitBreaker.recordFailure(trippedDomain);
    }

    expect(circuitBreaker.canRequest(trippedDomain)).toBe(false);
    expect(circuitBreaker.canRequest(cleanDomain)).toBe(true);
  });

  it('recordSuccess decrements failure count', () => {
    const domain = 'success-resets.com';
    for (let i = 0; i < 9; i++) {
      circuitBreaker.recordFailure(domain);
    }
    circuitBreaker.recordSuccess(domain);
    // 8 failures now — should still allow requests
    expect(circuitBreaker.canRequest(domain)).toBe(true);

    // Add one more failure — still 9, below threshold
    circuitBreaker.recordFailure(domain);
    expect(circuitBreaker.canRequest(domain)).toBe(true);
  });

  it('allows requests again after full reset and failures can trip again', () => {
    const domain = 'trips-twice.com';
    for (let i = 0; i < 10; i++) {
      circuitBreaker.recordFailure(domain);
    }
    expect(circuitBreaker.canRequest(domain)).toBe(false);

    // Reset
    jest.setSystemTime(Date.now() + 60_000);
    expect(circuitBreaker.canRequest(domain)).toBe(true);

    // Trip again
    for (let i = 0; i < 10; i++) {
      circuitBreaker.recordFailure(domain);
    }
    expect(circuitBreaker.canRequest(domain)).toBe(false);
  });
});
