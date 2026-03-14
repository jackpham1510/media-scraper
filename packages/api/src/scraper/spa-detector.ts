import type { SpaSignals } from '../types/index.js';

export const SPA_SCORE_THRESHOLD = 6;

/**
 * Score SPA signals. Higher score = more likely SPA.
 */
export function scoreSpa(signals: SpaSignals): number {
  let score = 0;

  if (signals.hasRootDiv) score += 3;
  if (signals.hasNextData || signals.hasNuxtData) score += 5;
  if (signals.hasNoScriptWarning) score += 2;
  if (signals.bodyTextLength < 500) score += 2;
  if (signals.scriptTagCount > 5) score += 1;

  return score;
}

/**
 * Determine if a page is a SPA.
 * CRITICAL: returns false if mediaCount > 0 — if we found media, it's serving content (SSR).
 */
export function isSpa(signals: SpaSignals, mediaCount: number): boolean {
  if (mediaCount > 0) return false;
  return scoreSpa(signals) >= SPA_SCORE_THRESHOLD;
}
