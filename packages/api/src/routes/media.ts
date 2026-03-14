import type { FastifyPluginAsync } from 'fastify';
import { mediaRepository } from '../db/repositories/media.repository.js';
import type { MediaFilters } from '../db/repositories/media.repository.js';

interface MediaQuery {
  page?: number;
  limit?: number;
  type?: 'image' | 'video';
  search?: string;
  jobId?: string;
}

interface MediaIdParams {
  id: string;
}

export const mediaRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/media
  // Paginated media listing with optional filters: type, search, jobId
  app.get<{ Querystring: MediaQuery }>(
    '/api/media',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            type: { type: 'string', enum: ['image', 'video'] },
            search: { type: 'string' },
            jobId: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { page = 1, limit = 20, type, search, jobId } = request.query;

      const filters: MediaFilters = {
        page,
        limit,
        ...(type !== undefined ? { type } : {}),
        ...(search !== undefined ? { search } : {}),
        ...(jobId !== undefined ? { jobId } : {}),
      };

      const { data, total } = await mediaRepository.findPaginated(filters);
      const totalPages = Math.ceil(total / limit);

      // Convert BigInt fields to strings for JSON serialization
      const serialized = data.map((item) => ({
        id: item.id.toString(),
        pageId: item.pageId.toString(),
        jobId: item.jobId,
        sourceUrl: item.sourceUrl,
        mediaUrl: item.mediaUrl,
        mediaType: item.mediaType,
        altText: item.altText,
        createdAt: item.createdAt.toISOString(),
      }));

      return reply.send({
        data: serialized,
        pagination: {
          page,
          limit,
          total,
          totalPages,
        },
      });
    },
  );

  // GET /api/media/:id
  // Fetch a single media item by ID
  app.get<{ Params: MediaIdParams }>(
    '/api/media/:id',
    async (request, reply) => {
      const { id } = request.params;

      let idBigInt: bigint;
      try {
        idBigInt = BigInt(id);
      } catch {
        return reply.status(400).send({ error: 'invalid_id', message: 'Invalid media ID' });
      }

      const item = await mediaRepository.findById(idBigInt);
      if (item === null) {
        return reply.status(404).send({ error: 'not_found', message: 'Media item not found' });
      }

      // Convert BigInt fields to strings for JSON serialization
      return reply.send({
        id: item.id.toString(),
        pageId: item.pageId.toString(),
        jobId: item.jobId,
        sourceUrl: item.sourceUrl,
        mediaUrl: item.mediaUrl,
        mediaType: item.mediaType,
        altText: item.altText,
        createdAt: item.createdAt.toISOString(),
      });
    },
  );
};
