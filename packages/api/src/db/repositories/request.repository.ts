import { db } from '../index.js';
import type { UrlStatus } from '../../types/index.js';

// Raw row shape returned by $queryRawUnsafe for scrape_requests
interface RawRequestRow {
  id: bigint;
  url: string;
}

export const requestRepository = {
  // Bulk insert scrape_requests and return inserted IDs with their URLs.
  // Uses $executeRawUnsafe for performance, then fetches by jobId to get assigned IDs.
  async bulkInsert(
    jobId: string,
    urls: string[],
  ): Promise<Array<{ id: bigint; url: string }>> {
    if (urls.length === 0) return [];

    // Build parameterized VALUES list: each row is (jobId, url, 'pending')
    const valuePlaceholders = urls.map(() => `(?, ?, 'pending')`).join(', ');
    const params: string[] = [];
    for (const url of urls) {
      params.push(jobId, url);
    }

    await db.$executeRawUnsafe(
      `INSERT INTO scrape_requests (job_id, url, status) VALUES ${valuePlaceholders}`,
      ...params,
    );

    // Use LAST_INSERT_ID() to get the first auto-generated ID from this batch insert
    const lastIdRaw: unknown = await db.$queryRawUnsafe(
      'SELECT LAST_INSERT_ID() as id',
    );
    const lastIdRows = lastIdRaw as Array<{ id: bigint }>;
    const firstId = lastIdRows[0]?.id ?? 0n;
    const count = BigInt(urls.length);

    // Fetch only the newly inserted rows using the ID range
    const rawRows: unknown = await db.$queryRawUnsafe(
      'SELECT id, url FROM scrape_requests WHERE id >= ? AND id < ? ORDER BY id ASC',
      firstId,
      firstId + count,
    );
    const rows = rawRows as RawRequestRow[];

    return rows;
  },

  // Update a single request's status by primary key.
  // ID must be passed in BullMQ payload — never scan by URL TEXT column.
  async updateStatus(
    id: bigint,
    status: UrlStatus,
    spaScore?: number,
    error?: string,
  ): Promise<void> {
    if (spaScore !== undefined && error !== undefined) {
      await db.$executeRawUnsafe(
        `UPDATE scrape_requests SET status = ?, spa_score = ?, error = ? WHERE id = ?`,
        status,
        spaScore,
        error,
        id,
      );
    } else if (spaScore !== undefined) {
      await db.$executeRawUnsafe(
        `UPDATE scrape_requests SET status = ?, spa_score = ? WHERE id = ?`,
        status,
        spaScore,
        id,
      );
    } else if (error !== undefined) {
      await db.$executeRawUnsafe(
        `UPDATE scrape_requests SET status = ?, error = ? WHERE id = ?`,
        status,
        error,
        id,
      );
    } else {
      await db.$executeRawUnsafe(
        `UPDATE scrape_requests SET status = ? WHERE id = ?`,
        status,
        id,
      );
    }
  },
};
