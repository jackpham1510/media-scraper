import { db } from '../index.js';

export const pageRepository = {
  // Upsert a scrape_page row and return the id.
  // Prisma doesn't support upsert on non-unique sourceUrl easily, so we
  // use findFirst then create (sourceUrl is not globally unique — same URL
  // can be scraped by different jobs).
  async upsert(
    jobId: string,
    sourceUrl: string,
    title: string | null,
    description: string | null,
  ): Promise<bigint> {
    const existing = await db.scrapePage.findFirst({
      where: { jobId, sourceUrl },
      select: { id: true },
    });

    if (existing !== null) {
      // Update metadata in case it changed (re-scrape scenario)
      await db.scrapePage.update({
        where: { id: existing.id },
        data: { title, description },
      });
      return existing.id;
    }

    const created = await db.scrapePage.create({
      data: { jobId, sourceUrl, title, description },
      select: { id: true },
    });

    return created.id;
  },
};
