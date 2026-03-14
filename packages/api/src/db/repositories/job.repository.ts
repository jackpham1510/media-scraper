import { db } from '../index.js';
import type { JobStatus } from '../../types/index.js';

export interface ScrapeJobDto {
  id: string;
  status: JobStatus;
  browserFallback: boolean;
  maxScrollDepth: number;
  urlsTotal: number;
  urlsDone: number;
  urlsSpaDetected: number;
  urlsBrowserDone: number;
  createdAt: Date;
  finishedAt: Date | null;
}

// Raw row shape returned by $queryRawUnsafe for scrape_jobs
interface RawJobRow {
  id: string;
  status: string;
  browser_fallback: number | boolean;
  max_scroll_depth: number;
  urls_total: number;
  urls_done: number;
  urls_spa_detected: number;
  urls_browser_done: number;
  created_at: Date;
  finished_at: Date | null;
}

function rowToDto(row: RawJobRow): ScrapeJobDto {
  return {
    id: row.id,
    status: row.status as JobStatus,
    browserFallback: Boolean(row.browser_fallback),
    maxScrollDepth: row.max_scroll_depth,
    urlsTotal: row.urls_total,
    urlsDone: row.urls_done,
    urlsSpaDetected: row.urls_spa_detected,
    urlsBrowserDone: row.urls_browser_done,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

export const jobRepository = {
  async create(
    id: string,
    urlsTotal: number,
    browserFallback: boolean,
    maxScrollDepth: number,
  ): Promise<void> {
    await db.$executeRawUnsafe(
      `INSERT INTO scrape_jobs (id, status, browser_fallback, max_scroll_depth, urls_total)
       VALUES (?, 'pending', ?, ?, ?)`,
      id,
      browserFallback ? 1 : 0,
      maxScrollDepth,
      urlsTotal,
    );
  },

  async updateStatus(id: string, status: JobStatus, finishedAt?: Date): Promise<void> {
    if (finishedAt !== undefined) {
      await db.$executeRawUnsafe(
        `UPDATE scrape_jobs SET status = ?, finished_at = ? WHERE id = ?`,
        status,
        finishedAt,
        id,
      );
    } else {
      await db.$executeRawUnsafe(
        `UPDATE scrape_jobs SET status = ? WHERE id = ?`,
        status,
        id,
      );
    }
  },

  // Atomic increment: UPDATE ... SET urls_done = urls_done + ? WHERE id = ?
  async incrementUrlsDone(id: string, count: number): Promise<void> {
    await db.$executeRawUnsafe(
      `UPDATE scrape_jobs SET urls_done = urls_done + ? WHERE id = ?`,
      count,
      id,
    );
  },

  // Atomic increment for spa detected count
  async incrementUrlsSpaDetected(id: string, count: number): Promise<void> {
    await db.$executeRawUnsafe(
      `UPDATE scrape_jobs SET urls_spa_detected = urls_spa_detected + ? WHERE id = ?`,
      count,
      id,
    );
  },

  // Atomic increment for browser done count.
  // When urls_browser_done + 1 >= urls_spa_detected, transitions status to 'done'.
  async incrementUrlsBrowserDone(id: string): Promise<void> {
    await db.$executeRawUnsafe(
      `UPDATE scrape_jobs
       SET urls_browser_done = urls_browser_done + 1,
           status = CASE
             WHEN urls_browser_done + 1 >= urls_spa_detected THEN 'done'
             ELSE status
           END,
           finished_at = CASE
             WHEN urls_browser_done + 1 >= urls_spa_detected THEN NOW(3)
             ELSE finished_at
           END
       WHERE id = ? AND status IN ('fast_complete', 'running')`,
      id,
    );
  },

  async findById(id: string): Promise<ScrapeJobDto | null> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const rawRows: unknown = await db.$queryRawUnsafe(
      `SELECT id, status, browser_fallback, max_scroll_depth,
              urls_total, urls_done, urls_spa_detected, urls_browser_done,
              created_at, finished_at
       FROM scrape_jobs
       WHERE id = ?
       LIMIT 1`,
      id,
    );
    const rows = rawRows as RawJobRow[];

    const row = rows[0];
    if (row === undefined) return null;

    return rowToDto(row);
  },

  // Atomic status transition after the fast queue finishes all URLs for a job.
  // If urls_spa_detected > 0 → 'fast_complete' (browser queue still has work).
  // If urls_spa_detected = 0 → 'done'.
  // Condition: only transitions if current status is 'running'.
  async transitionAfterFastComplete(id: string): Promise<void> {
    await db.$executeRawUnsafe(
      `UPDATE scrape_jobs
       SET status = CASE
         WHEN urls_spa_detected > 0 THEN 'fast_complete'
         ELSE 'done'
       END,
       finished_at = CASE
         WHEN urls_spa_detected = 0 THEN NOW(3)
         ELSE NULL
       END
       WHERE id = ? AND status = 'running'`,
      id,
    );
  },
};
