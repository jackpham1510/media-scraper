import { createHash } from 'node:crypto';
import type { Page } from 'playwright-core';
import { getBrowser } from './playwright.singleton.js';
import type { BrowserJobPayload, MediaInput, MediaType } from '../types/index.js';
import { jobRepository } from '../db/repositories/job.repository.js';
import { requestRepository } from '../db/repositories/request.repository.js';
import { pageRepository } from '../db/repositories/page.repository.js';
import { mediaRepository } from '../db/repositories/media.repository.js';

const BLOCKED_RESOURCE_TYPES = new Set(['stylesheet', 'font', 'image']);

/**
 * Scroll the page in increments to trigger lazy-loading.
 * Each step scrolls 400px and waits 200ms.
 */
async function autoScroll(page: Page, steps: number): Promise<void> {
  for (let i = 0; i < steps; i++) {
    await page.evaluate((scrollAmount) => {
      // This runs in browser context
      (globalThis as unknown as { scrollBy: (x: number, y: number) => void }).scrollBy(
        0,
        scrollAmount,
      );
    }, 400);
    await page.waitForTimeout(200);
  }
}

interface RawMediaItem {
  src: string;
  type: 'image' | 'video';
  altText: string | null;
}

/**
 * Extract all media URLs from the page, including lazy-load attributes.
 * The evaluate callback runs in browser context — DOM APIs are available there.
 */
async function extractMediaFromPage(page: Page): Promise<RawMediaItem[]> {
  // page.evaluate serializes the return value through JSON
  const items = await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const win = globalThis as any;
    const doc = win.document as {
      querySelectorAll: (sel: string) => ArrayLike<{
        getAttribute: (name: string) => string | null;
      }>;
      baseURI: string;
    };

    const results: Array<{ src: string; type: 'image' | 'video'; altText: string | null }> = [];

    function resolveUrl(src: string, base: string): string | null {
      if (!src || src.startsWith('data:')) return null;
      try {
        return new URL(src, base).href;
      } catch {
        return null;
      }
    }

    function getMediaSrc(el: { getAttribute: (name: string) => string | null }, base: string): string | null {
      const candidates = [
        el.getAttribute('src'),
        el.getAttribute('data-src'),
        el.getAttribute('data-lazy'),
        el.getAttribute('data-original'),
      ];
      for (const candidate of candidates) {
        if (candidate !== null && candidate !== '') {
          const resolved = resolveUrl(candidate, base);
          if (resolved !== null) return resolved;
        }
      }
      return null;
    }

    const base = doc.baseURI;

    // Images
    const imgs = Array.from(doc.querySelectorAll('img'));
    for (const img of imgs) {
      const src = getMediaSrc(img, base);
      if (src !== null) {
        results.push({ src, type: 'image', altText: img.getAttribute('alt') });
      }
    }

    // Videos and sources
    const videoEls = Array.from(doc.querySelectorAll('video, source'));
    for (const el of videoEls) {
      const src = getMediaSrc(el, base);
      if (src !== null) {
        results.push({ src, type: 'video', altText: null });
      }
    }

    return results;
  });

  return (items as RawMediaItem[]).filter((item) => item.src !== '');
}

/**
 * BullMQ processor for the scrape:browser queue.
 * Concurrency is 1 (enforced at Worker level) — DO NOT change.
 * ALWAYS calls page.close() in a finally block.
 */
export async function browserProcessor(job: { data: BrowserJobPayload }): Promise<void> {
  const { jobId, requestId, url, maxScrollDepth } = job.data;
  const requestIdBigInt = BigInt(requestId);

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    // Block unnecessary resource types to save bandwidth and RAM
    await page.route('**/*', async (route) => {
      const resourceType = route.request().resourceType();
      try {
        if (BLOCKED_RESOURCE_TYPES.has(resourceType)) {
          await route.abort();
        } else {
          await route.continue();
        }
      } catch {
        // Ignore route errors during page teardown (e.g., 'Target closed')
      }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(1_000);
    await autoScroll(page, maxScrollDepth);

    const pageTitle = await page.title();
    const pageDescription: string | null = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const doc = (globalThis as any).document as {
        querySelector: (sel: string) => { getAttribute: (name: string) => string | null } | null;
      };
      const meta = doc.querySelector('meta[name="description"]');
      return meta !== null ? meta.getAttribute('content') : null;
    });

    const rawMediaItems = await extractMediaFromPage(page);

    const pageId = await pageRepository.upsert(
      jobId,
      url,
      pageTitle || null,
      pageDescription,
    );

    if (rawMediaItems.length > 0) {
      const mediaInputs: MediaInput[] = rawMediaItems.map((item) => ({
        pageId,
        jobId,
        sourceUrl: url,
        mediaUrl: item.src,
        mediaUrlHash: createHash('sha256').update(item.src).digest('hex'),
        mediaType: item.type as MediaType,
        altText: item.altText,
      }));

      await mediaRepository.upsertBatch(mediaInputs);
    }

    await requestRepository.updateStatus(requestIdBigInt, 'done');
    await jobRepository.incrementUrlsDone(jobId, 1);
    await jobRepository.incrementUrlsBrowserDone(jobId);
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await requestRepository.updateStatus(requestIdBigInt, 'failed', undefined, errorMessage);
    // Still transition job counters even on failure so urlsDone reaches urlsTotal
    await jobRepository.incrementUrlsDone(jobId, 1);
    await jobRepository.incrementUrlsBrowserDone(jobId);
    throw err;
  } finally {
    // ALWAYS close the page — even on error
    await page.close();
  }
}
