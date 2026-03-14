import { createHash } from 'node:crypto';
import type { Page } from 'playwright-core';
import { getBrowser } from './playwright.singleton.js';
import type { BrowserJobPayload, MediaInput, MediaType } from '../types/index.js';

// TODO: Replace with real implementations once db/repositories/ is created
// import { jobRepository } from '../db/repositories/job.repository.js';
// import { mediaRepository } from '../db/repositories/media.repository.js';
// import { scrapeRequestRepository } from '../db/repositories/scrape-request.repository.js';
// import { scrapePageRepository } from '../db/repositories/scrape-page.repository.js';

// TODO: Replace these stubs with real repository calls once db/repositories/ exists
const jobRepository = {
  async incrementBrowserDoneAndTransition(_jobId: string): Promise<void> {
    // TODO: atomic SQL:
    // UPDATE scrape_jobs
    //   SET urls_browser_done = urls_browser_done + 1,
    //       status = CASE WHEN urls_browser_done + 1 >= urls_spa_detected THEN 'done' ELSE status END,
    //       finished_at = CASE WHEN urls_browser_done + 1 >= urls_spa_detected THEN NOW() ELSE NULL END
    //   WHERE id = ?
  },
  async incrementUrlsDone(_jobId: string): Promise<void> {
    // TODO: UPDATE scrape_jobs SET urls_done = urls_done + 1 WHERE id = ?
  },
};

const scrapeRequestRepository = {
  async markBrowserDone(_requestId: number): Promise<void> {
    // TODO: UPDATE scrape_requests SET status = 'done', scrape_path = 'browser' WHERE id = ?
  },
  async markFailed(_requestId: number, _error: string): Promise<void> {
    // TODO: UPDATE scrape_requests SET status = 'failed', error = ? WHERE id = ?
  },
};

const scrapePageRepository = {
  async insertPage(
    _jobId: string,
    _sourceUrl: string,
    _title: string | null,
    _description: string | null,
  ): Promise<bigint> {
    // TODO: INSERT INTO scrape_pages ... RETURNING id
    return BigInt(0);
  },
};

const mediaRepository = {
  async batchUpsert(_items: MediaInput[]): Promise<void> {
    // TODO: INSERT INTO media_items ... ON DUPLICATE KEY UPDATE ...
  },
};

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

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    // Block unnecessary resource types to save bandwidth and RAM
    await page.route('**/*', (route) => {
      if (BLOCKED_RESOURCE_TYPES.has(route.request().resourceType())) {
        void route.abort();
      } else {
        void route.continue();
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

    const pageId = await scrapePageRepository.insertPage(
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

      await mediaRepository.batchUpsert(mediaInputs);
    }

    await scrapeRequestRepository.markBrowserDone(requestId);
    await jobRepository.incrementUrlsDone(jobId);
    await jobRepository.incrementBrowserDoneAndTransition(jobId);
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await scrapeRequestRepository.markFailed(requestId, errorMessage);
    // Still transition job even on failure
    await jobRepository.incrementBrowserDoneAndTransition(jobId);
    throw err;
  } finally {
    // ALWAYS close the page — even on error
    await page.close();
  }
}
