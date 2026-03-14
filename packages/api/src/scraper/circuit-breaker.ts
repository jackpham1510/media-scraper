const FAILURE_THRESHOLD = 10;
const RESET_WINDOW_MS = 60_000; // 60 seconds

interface DomainState {
  failures: number;
  trippedAt: number | null;
}

/**
 * Per-domain circuit breaker.
 * Trips after FAILURE_THRESHOLD failures; resets after RESET_WINDOW_MS.
 */
class CircuitBreaker {
  private readonly states = new Map<string, DomainState>();

  private getState(domain: string): DomainState {
    let state = this.states.get(domain);
    if (state === undefined) {
      state = { failures: 0, trippedAt: null };
      this.states.set(domain, state);
    }
    return state;
  }

  canRequest(domain: string): boolean {
    const state = this.getState(domain);

    if (state.trippedAt === null) return true;

    const elapsed = Date.now() - state.trippedAt;
    if (elapsed >= RESET_WINDOW_MS) {
      // Reset circuit
      state.failures = 0;
      state.trippedAt = null;
      return true;
    }

    return false;
  }

  recordFailure(domain: string): void {
    const state = this.getState(domain);

    // If already tripped, extend the window
    if (state.trippedAt !== null) {
      state.trippedAt = Date.now();
      return;
    }

    state.failures++;
    if (state.failures >= FAILURE_THRESHOLD) {
      state.trippedAt = Date.now();
    }
  }

  recordSuccess(domain: string): void {
    const state = this.getState(domain);
    // On success, decrement failure count (but don't go below 0)
    if (state.failures > 0) {
      state.failures--;
    }
  }
}

// Singleton shared across all concurrent requests
export const circuitBreaker = new CircuitBreaker();
