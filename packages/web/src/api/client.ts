import axios from 'axios';
import type { JobStatus, MediaFilters, MediaResponse } from '../types.js';

const axiosInstance = axios.create({
  baseURL: import.meta.env['VITE_API_BASE_URL'] ?? '',
  headers: { 'Content-Type': 'application/json' },
});

export const api = {
  async scrape(
    urls: string[],
    options?: { browserFallback?: boolean; maxScrollDepth?: number },
  ): Promise<{ jobId: string }> {
    const response = await axiosInstance.post<{ jobId: string }>('/api/scrape', {
      urls,
      options,
    });
    return response.data;
  },

  async getJobStatus(jobId: string): Promise<JobStatus> {
    const response = await axiosInstance.get<JobStatus>(`/api/scrape/${jobId}`);
    return response.data;
  },

  async getMedia(filters: MediaFilters): Promise<MediaResponse> {
    const params: Record<string, string | number> = {};
    if (filters.page !== undefined) params['page'] = filters.page;
    if (filters.limit !== undefined) params['limit'] = filters.limit;
    if (filters.type !== undefined) params['type'] = filters.type;
    if (filters.search !== undefined && filters.search !== '') params['search'] = filters.search;
    if (filters.jobId !== undefined && filters.jobId !== '') params['jobId'] = filters.jobId;

    const response = await axiosInstance.get<MediaResponse>('/api/media', { params });
    return response.data;
  },
};
