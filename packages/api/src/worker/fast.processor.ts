import { Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { fetchUrl, isFetchError } from '../scraper/http-client.js';
import { parsePage } from '../scraper/parser.js';
import { isSpa } from '../scraper/spa-detector.js';
import type { FastJobPayload, MediaInput } from '../types/index.js';
import { jobRepository } from '../db/repositories/job.repository.js';
import { requestRepository } from '../db/repositories/request.repository.js';
import { pageRepository } from '../db/repositories/page.repository.js';
import { mediaRepository } from '../db/repositories/media.repository.js';

const BATCH_SIZE = 500;
const BATCH_FLUSH_INTERVAL_MS = 5_000;

// Module level — created once (singleton, not per-job)
const browserQueue = new Queue('scrape:browser', {
  connection: {
    host: process.env['REDIS_HOST'] ?? 'localhost',
    port: parseInt(process.env['REDIS_PORT'] ?? '6379', 10),
  },
});

/**
 * Flush the media batch buffer to the database.
 */
async function flushBatch(buffer: MediaInput[]): Promise<void> {
  if (buffer.length === 0) return;
  const items = buffer.splice(0);
  await mediaRepository.upsertBatch(items);
}

/**
 * BullMQ processor for the scrape:fast queue.
 * CRITICAL: Does NOT call pLimit() — globalLimit is the process singleton in http-client.ts.
 * Uses Promise.allSettled (never Promise.all) for batch operations.
 */
export async function fastProcessor(job: { data: FastJobPayload }): Promise<void> {
  const { jobId, browserFallback, maxScrollDepth, urls } = job.data;

  // Transition to 'running' at the start of processing (worker picked up the job)
  await jobRepository.updateStatus(jobId, 'running');

  const mediaBatch: MediaInput[] = [];
  let spaCount = 0;

  // Periodic batch flush
  const flushInterval = setInterval(() => {
    void flushBatch(mediaBatch).catch((err: unknown) => {
      console.error('Periodic batch flush error:', err);
    });
  }, BATCH_FLUSH_INTERVAL_MS);

  try {
    const results = await Promise.allSettled(
      urls.map(async ({ id, url }) => {
        const requestId = BigInt(id);
        const result = await fetchUrl(url);

        if (isFetchError(result)) {
          await requestRepository.updateStatus(requestId, 'failed', undefined, result.error);
          await jobRepository.incrementUrlsDone(jobId, 1);
          return;
        }

        const body = Readable.from(result.body);
        const parsed = await parsePage(body, url);
        const { spaSignals, mediaItems, title, description } = parsed;

        const detectedAsSpa = isSpa(spaSignals, parsed.mediaItems.length);

        if (detectedAsSpa) {
          if (browserFallback) {
            await requestRepository.updateStatus(requestId, 'spa_detected');
            await jobRepository.incrementUrlsSpaDetected(jobId, 1);
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
            await requestRepository.updateStatus(requestId, 'failed', undefined, 'spa_detected');
            await jobRepository.incrementUrlsDone(jobId, 1);
          }
          return;
        }

        // Not SPA — store page and media
        const pageId = await pageRepository.upsert(jobId, url, title, description);

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

        await requestRepository.updateStatus(requestId, 'done');
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
    await jobRepository.transitionAfterFastComplete(jobId);
  } finally {
    clearInterval(flushInterval);
  }
}
