import type { Prisma } from '@prisma/client';
import { db } from '../index.js';
import type { UrlStatus } from '../../types/index.js';

// Raw row shape returned by $queryRawUnsafe for scrape_requests
interface RawRequestRow {
  id: bigint;
  url: string;
}

export const requestRepository = {
  // Bulk insert scrape_requests and return inserted IDs with their URLs.
  // KEEP RAW: bulk insert + LAST_INSERT_ID() + contiguous range select in transaction
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

    // Wrap INSERT + LAST_INSERT_ID() + SELECT in a single interactive transaction
    // so all three queries run on the same connection (LAST_INSERT_ID() is session-scoped).
    const rows = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO scrape_requests (job_id, url, status) VALUES ${valuePlaceholders}`,
        ...params,
      );

      // LAST_INSERT_ID() returns the first ID assigned to the batch INSERT
      const lastIdRaw: unknown = await tx.$queryRawUnsafe(
        'SELECT LAST_INSERT_ID() as id',
      );
      const lastIdResult = lastIdRaw as Array<{ id: bigint }>;
      const firstId = lastIdResult[0]?.id ?? 0n;
      const count = BigInt(urls.length);

      // Fetch only the newly inserted rows using the contiguous ID range
      const insertedRaw: unknown = await tx.$queryRawUnsafe(
        'SELECT id, url FROM scrape_requests WHERE id >= ? AND id < ? ORDER BY id ASC',
        firstId,
        firstId + count,
      );
      return insertedRaw as RawRequestRow[];
    });

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
    await db.scrapeRequest.update({
      where: { id },
      data: {
        status,
        ...(spaScore !== undefined && { spaScore }),
        ...(error !== undefined && { error }),
      },
    });
  },
};
