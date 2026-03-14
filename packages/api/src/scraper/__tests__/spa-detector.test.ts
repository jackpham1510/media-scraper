import { describe, it, expect } from '@jest/globals';
import { scoreSpa, isSpa, SPA_SCORE_THRESHOLD } from '../spa-detector.js';
import type { SpaSignals } from '../../types/index.js';

function makeSignals(overrides: Partial<SpaSignals> = {}): SpaSignals {
  return {
    hasRootDiv: false,
    hasNextData: false,
    hasNuxtData: false,
    hasNoScriptWarning: false,
    bodyTextLength: 1000,
    scriptTagCount: 2,
    mediaCount: 0,
    ...overrides,
  };
}

describe('scoreSpa', () => {
  it('scores 0 for completely static signals', () => {
    const signals = makeSignals({ bodyTextLength: 1000, scriptTagCount: 2 });
    expect(scoreSpa(signals)).toBe(0);
  });

  it('adds 3 for hasRootDiv', () => {
    const signals = makeSignals({ hasRootDiv: true });
    expect(scoreSpa(signals)).toBe(3);
  });

  it('adds 5 for hasNextData', () => {
    const signals = makeSignals({ hasNextData: true });
    expect(scoreSpa(signals)).toBe(5);
  });

  it('adds 5 for hasNuxtData', () => {
    const signals = makeSignals({ hasNuxtData: true });
    expect(scoreSpa(signals)).toBe(5);
  });

  it('adds 2 for hasNoScriptWarning', () => {
    const signals = makeSignals({ hasNoScriptWarning: true });
    expect(scoreSpa(signals)).toBe(2);
  });

  it('adds 2 for bodyTextLength < 500', () => {
    const signals = makeSignals({ bodyTextLength: 100 });
    expect(scoreSpa(signals)).toBe(2);
  });

  it('adds 1 for scriptTagCount > 5', () => {
    const signals = makeSignals({ scriptTagCount: 6 });
    expect(scoreSpa(signals)).toBe(1);
  });

  it('does not add 1 for scriptTagCount exactly 5', () => {
    const signals = makeSignals({ scriptTagCount: 5 });
    expect(scoreSpa(signals)).toBe(0);
  });
});

describe('isSpa', () => {
  describe('patterns that should return true (SPA)', () => {
    it('Next.js app: hasRootDiv + hasNextData', () => {
      const signals = makeSignals({ hasRootDiv: true, hasNextData: true });
      expect(isSpa(signals, 0)).toBe(true); // score = 8
    });

    it('Nuxt.js app: hasRootDiv + hasNuxtData', () => {
      const signals = makeSignals({ hasRootDiv: true, hasNuxtData: true });
      expect(isSpa(signals, 0)).toBe(true); // score = 8
    });

    it('React app: hasRootDiv + short body + many scripts', () => {
      const signals = makeSignals({
        hasRootDiv: true,
        bodyTextLength: 50,
        scriptTagCount: 10,
      });
      expect(isSpa(signals, 0)).toBe(true); // score = 3 + 2 + 1 = 6
    });

    it('Next.js with noscript warning and short body', () => {
      const signals = makeSignals({
        hasNextData: true,
        hasNoScriptWarning: true,
        bodyTextLength: 200,
      });
      expect(isSpa(signals, 0)).toBe(true); // score = 5 + 2 + 2 = 9
    });

    it('Generic SPA: root div + noscript + short body + many scripts', () => {
      const signals = makeSignals({
        hasRootDiv: true,
        hasNoScriptWarning: true,
        bodyTextLength: 100,
        scriptTagCount: 8,
      });
      expect(isSpa(signals, 0)).toBe(true); // score = 3 + 2 + 2 + 1 = 8
    });
  });

  describe('patterns that should return false (static)', () => {
    it('fully static page with content', () => {
      const signals = makeSignals({ bodyTextLength: 5000, scriptTagCount: 1 });
      expect(isSpa(signals, 0)).toBe(false); // score = 0
    });

    it('page with many scripts but lots of content', () => {
      const signals = makeSignals({ scriptTagCount: 10, bodyTextLength: 2000 });
      expect(isSpa(signals, 0)).toBe(false); // score = 1
    });

    it('page with root div but lots of content', () => {
      const signals = makeSignals({ hasRootDiv: true, bodyTextLength: 3000 });
      expect(isSpa(signals, 0)).toBe(false); // score = 3 (below threshold 6)
    });

    it('noscript warning but otherwise rich content', () => {
      const signals = makeSignals({
        hasNoScriptWarning: true,
        bodyTextLength: 2000,
        scriptTagCount: 3,
      });
      expect(isSpa(signals, 0)).toBe(false); // score = 2
    });

    it('short body but no other signals', () => {
      const signals = makeSignals({ bodyTextLength: 100, scriptTagCount: 2 });
      expect(isSpa(signals, 0)).toBe(false); // score = 2
    });
  });

  describe('CRITICAL: mediaCount overrides SPA detection', () => {
    it('returns false even for Next.js SPA if mediaCount > 0', () => {
      const signals = makeSignals({
        hasRootDiv: true,
        hasNextData: true,
        bodyTextLength: 50,
        scriptTagCount: 10,
        mediaCount: 5,
      });
      expect(isSpa(signals, 5)).toBe(false);
    });

    it('returns false for highest-scoring SPA if mediaCount is 1', () => {
      const signals = makeSignals({
        hasRootDiv: true,
        hasNextData: true,
        hasNuxtData: true,
        hasNoScriptWarning: true,
        bodyTextLength: 10,
        scriptTagCount: 20,
        mediaCount: 1,
      });
      expect(isSpa(signals, 1)).toBe(false);
    });

    it('uses passed-in mediaCount argument, not signals.mediaCount', () => {
      // signals.mediaCount = 0 but argument = 3 — should return false
      const signals = makeSignals({
        hasRootDiv: true,
        hasNextData: true,
        mediaCount: 0,
      });
      expect(isSpa(signals, 3)).toBe(false);
    });

    it('returns true when mediaCount argument is 0 even if signals.mediaCount nonzero', () => {
      // Verifies it uses the mediaCount parameter
      const signals = makeSignals({
        hasRootDiv: true,
        hasNextData: true,
        mediaCount: 5,
      });
      expect(isSpa(signals, 0)).toBe(true);
    });

    it('SPA_SCORE_THRESHOLD is 6', () => {
      expect(SPA_SCORE_THRESHOLD).toBe(6);
    });
  });
});
