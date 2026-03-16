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

export const jobRepository = {
  async create(
    id: string,
    urlsTotal: number,
    browserFallback: boolean,
    maxScrollDepth: number,
  ): Promise<void> {
    await db.scrapeJob.create({
      data: { id, status: 'pending', browserFallback, maxScrollDepth, urlsTotal },
    });
  },

  async updateStatus(id: string, status: JobStatus, finishedAt?: Date): Promise<void> {
    await db.scrapeJob.update({
      where: { id },
      data: { status, ...(finishedAt !== undefined && { finishedAt }) },
    });
  },

  async incrementUrlsDone(id: string, count: number): Promise<void> {
    await db.scrapeJob.update({
      where: { id },
      data: { urlsDone: { increment: count } },
    });
  },

  async incrementUrlsSpaDetected(id: string, count: number): Promise<void> {
    await db.scrapeJob.update({
      where: { id },
      data: { urlsSpaDetected: { increment: count } },
    });
  },

  // Atomic increment for browser done count.
  // When urls_browser_done + 1 >= urls_spa_detected, transitions status to 'done'.
  // KEEP RAW: atomic CASE expression with self-referencing columns + conditional status transition
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
    const row = await db.scrapeJob.findUnique({ where: { id } });
    if (row === null) return null;
    return row;
  },

  // Atomic status transition after the fast queue finishes all URLs for a job.
  // If urls_spa_detected > 0 → 'fast_complete' (browser queue still has work).
  // If urls_spa_detected = 0 → 'done'.
  // KEEP RAW: atomic CASE expression referencing current column values + conditional WHERE
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

  async findPaginated(filter: {
    statuses: JobStatus[];
    page: number;
    limit: number;
    orderBy: 'createdAt' | 'finishedAt';
  }): Promise<{ rows: ScrapeJobDto[]; total: number }> {
    if (filter.statuses.length === 0) return { rows: [], total: 0 };

    const where = { status: { in: filter.statuses } };
    const orderBy = { [filter.orderBy]: 'desc' as const };
    const skip = (filter.page - 1) * filter.limit;

    const [rows, total] = await Promise.all([
      db.scrapeJob.findMany({ where, orderBy, take: filter.limit, skip }),
      db.scrapeJob.count({ where }),
    ]);

    return { rows, total };
  },
};
