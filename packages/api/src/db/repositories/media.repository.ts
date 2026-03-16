import { db } from '../index.js';
import type { MediaInput } from '../../types/index.js';

export interface MediaFilters {
  page: number;    // 1-based
  limit: number;   // max 100
  type?: 'image' | 'video';
  search?: string; // LIKE substring match on alt_text OR source_url
  jobId?: string;
}

export interface MediaItemDto {
  id: bigint;
  pageId: bigint;
  jobId: string;
  sourceUrl: string;
  mediaUrl: string;
  mediaType: 'image' | 'video';
  altText: string | null;
  createdAt: Date;
}

export const mediaRepository = {
  // Bulk upsert up to 500 media items.
  // Deduplication via media_url_hash (SHA-256 of mediaUrl).
  // KEEP RAW: bulk INSERT ... ON DUPLICATE KEY UPDATE with dynamic value count
  async upsertBatch(items: MediaInput[]): Promise<void> {
    if (items.length === 0) return;

    // Each row needs 7 params: page_id, job_id, source_url, media_url, media_url_hash, media_type, alt_text
    const valuePlaceholders = items.map(() => `(?, ?, ?, ?, ?, ?, ?)`).join(', ');
    const params: (bigint | string | null)[] = [];

    for (const item of items) {
      params.push(
        item.pageId,
        item.jobId,
        item.sourceUrl,
        item.mediaUrl,
        item.mediaUrlHash,
        item.mediaType,
        item.altText,
      );
    }

    await db.$executeRawUnsafe(
      `INSERT INTO media_items (page_id, job_id, source_url, media_url, media_url_hash, media_type, alt_text)
       VALUES ${valuePlaceholders}
       ON DUPLICATE KEY UPDATE
         page_id    = VALUES(page_id),
         job_id     = VALUES(job_id),
         source_url = VALUES(source_url),
         alt_text   = VALUES(alt_text)`,
      ...params,
    );
  },

  // Paginated query with optional filters: type, search (LIKE on alt_text/source_url), jobId.
  async findPaginated(
    filters: MediaFilters,
  ): Promise<{ data: MediaItemDto[]; total: number }> {
    const { page, limit, type, search, jobId } = filters;
    const skip = (page - 1) * limit;

    // Build Prisma where clause dynamically
    const where: {
      jobId?: string;
      mediaType?: 'image' | 'video';
      OR?: Array<{ altText?: { contains: string }; sourceUrl?: { contains: string } }>;
    } = {};

    if (jobId !== undefined) {
      where.jobId = jobId;
    }

    if (type !== undefined) {
      where.mediaType = type;
    }

    if (search !== undefined && search.length > 0) {
      where.OR = [
        { altText: { contains: search } },
        { sourceUrl: { contains: search } },
      ];
    }

    const [rows, total] = await Promise.all([
      db.mediaItem.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        skip,
      }),
      db.mediaItem.count({ where }),
    ]);

    return {
      data: rows.map((row) => ({
        id: row.id,
        pageId: row.pageId,
        jobId: row.jobId,
        sourceUrl: row.sourceUrl,
        mediaUrl: row.mediaUrl,
        mediaType: row.mediaType,
        altText: row.altText,
        createdAt: row.createdAt,
      })),
      total,
    };
  },

  // Fetch a single media item by ID.
  async findById(id: bigint): Promise<MediaItemDto | null> {
    const row = await db.mediaItem.findUnique({ where: { id } });
    if (row === null) return null;

    return {
      id: row.id,
      pageId: row.pageId,
      jobId: row.jobId,
      sourceUrl: row.sourceUrl,
      mediaUrl: row.mediaUrl,
      mediaType: row.mediaType,
      altText: row.altText,
      createdAt: row.createdAt,
    };
  },
};
