import { Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { fetchUrl, isFetchError } from '../scraper/http-client.js';
import { parsePage } from '../scraper/parser.js';
import { isSpa } from '../scraper/spa-detector.js';
import type { FastJobPayload, MediaInput } from '../types/index.js';

// TODO: Replace with real implementations once db/repositories/ is created
// import { jobRepository } from '../db/repositories/job.repository.js';
// import { mediaRepository } from '../db/repositories/media.repository.js';
// import { scrapeRequestRepository } from '../db/repositories/scrape-request.repository.js';
// import { scrapePageRepository } from '../db/repositories/scrape-page.repository.js';

const BATCH_SIZE = 500;
const BATCH_FLUSH_INTERVAL_MS = 5_000;

// TODO: Replace these stubs with real repository calls once db/repositories/ exists
const jobRepository = {
  async transitionToFastComplete(_jobId: string, _spaCount: number): Promise<void> {
    // TODO: atomic SQL UPDATE scrape_jobs SET status = CASE WHEN urls_spa_detected > 0 THEN 'fast_complete' ELSE 'done' END WHERE id = ?
  },
  async incrementUrlsDone(_jobId: string, _count: number): Promise<void> {
    // TODO: atomic SQL UPDATE scrape_jobs SET urls_done = urls_done + ? WHERE id = ?
  },
  async incrementSpaDetected(_jobId: string, _count: number): Promise<void> {
    // TODO: atomic SQL UPDATE scrape_jobs SET urls_spa_detected = urls_spa_detected + ? WHERE id = ?
  },
};

const scrapeRequestRepository = {
  async markDone(_requestId: number): Promise<void> {
    // TODO: UPDATE scrape_requests SET status = 'done' WHERE id = ?
  },
  async markFailed(_requestId: number, _error: string): Promise<void> {
    // TODO: UPDATE scrape_requests SET status = 'failed', error = ? WHERE id = ?
  },
  async markSpaDetected(_requestId: number, _spaScore: number): Promise<void> {
    // TODO: UPDATE scrape_requests SET status = 'spa_detected', spa_score = ?, scrape_path = 'browser' WHERE id = ?
  },
};

const scrapePageRepository = {
  async insertPage(_jobId: string, _sourceUrl: string, _title: string | null, _description: string | null): Promise<bigint> {
    // TODO: INSERT INTO scrape_pages ... RETURNING id
    return BigInt(0);
  },
};

const mediaRepository = {
  async batchUpsert(_items: MediaInput[]): Promise<void> {
    // TODO: INSERT INTO media_items ... ON DUPLICATE KEY UPDATE ...
  },
};

/**
 * Flush the media batch buffer to the database.
 */
async function flushBatch(buffer: MediaInput[]): Promise<void> {
  if (buffer.length === 0) return;
  const items = buffer.splice(0);
  await mediaRepository.batchUpsert(items);
}

/**
 * BullMQ processor for the scrape:fast queue.
 * CRITICAL: Does NOT call pLimit() — globalLimit is the process singleton in http-client.ts.
 * Uses Promise.allSettled (never Promise.all) for batch operations.
 */
export async function fastProcessor(job: { data: FastJobPayload }): Promise<void> {
  const { jobId, browserFallback, maxScrollDepth, urls } = job.data;

  const mediaBatch: MediaInput[] = [];
  let spaCount = 0;

  // Redis connection for browser queue (use env or default)
  const browserQueue = new Queue('scrape:browser', {
    connection: {
      host: process.env['REDIS_HOST'] ?? 'localhost',
      port: parseInt(process.env['REDIS_PORT'] ?? '6379', 10),
    },
  });

  // Periodic batch flush
  const flushInterval = setInterval(() => {
    void flushBatch(mediaBatch).catch((err: unknown) => {
      console.error('Periodic batch flush error:', err);
    });
  }, BATCH_FLUSH_INTERVAL_MS);

  try {
    const results = await Promise.allSettled(
      urls.map(async ({ id, url }) => {
        const result = await fetchUrl(url);

        if (isFetchError(result)) {
          await scrapeRequestRepository.markFailed(id, result.error);
          await jobRepository.incrementUrlsDone(jobId, 1);
          return;
        }

        const body = Readable.from(result.body);
        const parsed = await parsePage(body, url);
        const { spaSignals, mediaItems, title, description } = parsed;

        const detectedAsSpa = isSpa(spaSignals, spaSignals.mediaCount);

        if (detectedAsSpa) {
          if (browserFallback) {
            await scrapeRequestRepository.markSpaDetected(id, 0);
            await jobRepository.incrementSpaDetected(jobId, 1);
            spaCount++;
            await browserQueue.add(
              'scrape-url',
              {
                jobId,
                requestId: id,
                url,
                maxScrollDepth,
              },
              { priority: 10 },
            );
          } else {
            await scrapeRequestRepository.markFailed(id, 'spa_detected');
            await jobRepository.incrementUrlsDone(jobId, 1);
          }
          return;
        }

        // Not SPA — store page and media
        const pageId = await scrapePageRepository.insertPage(jobId, url, title, description);

        for (const item of mediaItems) {
          const mediaUrlHash = createHash('sha256').update(item.mediaUrl).digest('hex');
          mediaBatch.push({
            pageId,
            jobId,
            sourceUrl: url,
            mediaUrl: item.mediaUrl,
            mediaUrlHash,
            mediaType: item.mediaType,
            altText: item.altText,
          });

          if (mediaBatch.length >= BATCH_SIZE) {
            await flushBatch(mediaBatch);
          }
        }

        await scrapeRequestRepository.markDone(id);
        await jobRepository.incrementUrlsDone(jobId, 1);
      }),
    );

    // Log any unexpected rejections
    for (const r of results) {
      if (r.status === 'rejected') {
        console.error('fastProcessor url error:', r.reason);
      }
    }

    // Final flush
    await flushBatch(mediaBatch);

    // Transition job status atomically
    await jobRepository.transitionToFastComplete(jobId, spaCount);
  } finally {
    clearInterval(flushInterval);
    await browserQueue.close();
  }
}
