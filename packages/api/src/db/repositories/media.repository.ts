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

// Raw row shape returned by $queryRawUnsafe for media_items
interface RawMediaRow {
  id: bigint;
  page_id: bigint;
  job_id: string;
  source_url: string;
  media_url: string;
  media_type: string;
  alt_text: string | null;
  created_at: Date;
}

interface CountRow {
  total: bigint;
}

function rowToDto(row: RawMediaRow): MediaItemDto {
  return {
    id: row.id,
    pageId: row.page_id,
    jobId: row.job_id,
    sourceUrl: row.source_url,
    mediaUrl: row.media_url,
    mediaType: row.media_type as 'image' | 'video',
    altText: row.alt_text,
    createdAt: row.created_at,
  };
}

export const mediaRepository = {
  // Bulk upsert up to 500 media items.
  // Deduplication via media_url_hash (SHA-256 of mediaUrl).
  // Uses $executeRawUnsafe with a parameterized multi-row INSERT ... ON DUPLICATE KEY UPDATE.
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

  // Paginated query with optional filters: type, search (FULLTEXT on alt_text), jobId.
  async findPaginated(
    filters: MediaFilters,
  ): Promise<{ data: MediaItemDto[]; total: number }> {
    const { page, limit, type, search, jobId } = filters;
    const offset = (page - 1) * limit;

    // Build WHERE clause dynamically
    const conditions: string[] = [];
    const conditionParams: (string | number)[] = [];

    if (jobId !== undefined) {
      conditions.push('job_id = ?');
      conditionParams.push(jobId);
    }

    if (type !== undefined) {
      conditions.push('media_type = ?');
      conditionParams.push(type);
    }

    if (search !== undefined && search.length > 0) {
      // Substring match on alt_text and source_url
      conditions.push('(alt_text LIKE ? OR source_url LIKE ?)');
      conditionParams.push(`%${search}%`, `%${search}%`);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const dataQuery = `SELECT id, page_id, job_id, source_url, media_url, media_type, alt_text, created_at
      FROM media_items
      ${whereClause}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?`;

    const countQuery = `SELECT COUNT(*) AS total FROM media_items ${whereClause}`;

    const [rawRows, rawCountRows] = await Promise.all([
      db.$queryRawUnsafe(dataQuery, ...conditionParams, limit, offset) as Promise<unknown>,
      db.$queryRawUnsafe(countQuery, ...conditionParams) as Promise<unknown>,
    ]);
    const rows = rawRows as RawMediaRow[];
    const countRows = rawCountRows as CountRow[];

    const countRow = countRows[0];
    const total = countRow !== undefined ? Number(countRow.total) : 0;

    return {
      data: rows.map(rowToDto),
      total,
    };
  },

  // Fetch a single media item by ID.
  async findById(id: bigint): Promise<MediaItemDto | null> {
    const rawRows: unknown = await db.$queryRawUnsafe(
      `SELECT id, page_id, job_id, source_url, media_url, media_type, alt_text, created_at
       FROM media_items
       WHERE id = ?
       LIMIT 1`,
      id,
    );
    const rows = rawRows as RawMediaRow[];

    const row = rows[0];
    if (row === undefined) return null;

    return rowToDto(row);
  },
};
