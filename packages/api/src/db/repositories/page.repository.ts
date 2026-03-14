import { db } from '../index.js';

export const pageRepository = {
  async upsert(
    jobId: string,
    sourceUrl: string,
    title: string | null,
    description: string | null,
    fetchedHtml: string | null,
  ): Promise<bigint> {
    // Atomic insert — ignore duplicate (jobId, sourceUrl) pairs
    await db.$executeRawUnsafe(
      `INSERT IGNORE INTO scrape_pages (job_id, source_url, title, description, fetched_html, scraped_at)
       VALUES (?, ?, ?, ?, ?, NOW(3))`,
      jobId,
      sourceUrl,
      title,
      description,
      fetchedHtml,
    );

    // Fetch the id (either newly inserted or existing row)
    const rows = (await db.$queryRawUnsafe(
      `SELECT id FROM scrape_pages WHERE job_id = ? AND source_url = ? LIMIT 1`,
      jobId,
      sourceUrl,
    )) as Array<{ id: bigint }>;

    const row = rows[0];
    if (row === undefined) {
      throw new Error(`ScrapePage row not found after upsert: jobId=${jobId} sourceUrl=${sourceUrl}`);
    }

    return row.id;
  },
};
