import type { JobStatus, JobListResponse, MediaFilters, MediaResponse } from '../types.js';

const API_BASE = import.meta.env['VITE_API_BASE'] ?? '';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const hasBody = options?.body !== undefined;
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...options?.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  async scrape(
    urls: string[],
    options?: { browserFallback?: boolean; maxScrollDepth?: number },
  ): Promise<{ jobId: string }> {
    return request<{ jobId: string }>('/api/scrape', {
      method: 'POST',
      body: JSON.stringify({ urls, options }),
    });
  },

  async getJobStatus(jobId: string): Promise<JobStatus> {
    return request<JobStatus>(`/api/scrape/${encodeURIComponent(jobId)}`);
  },

  async getJobs(
    status: 'active' | 'done',
    page: number,
    limit = 20,
  ): Promise<JobListResponse> {
    const params = new URLSearchParams({ status, page: String(page), limit: String(limit) });
    return request<JobListResponse>(`/api/jobs?${params.toString()}`);
  },

  async getJobStats(): Promise<{ activeCount: number }> {
    return request<{ activeCount: number }>('/api/jobs/stats');
  },

  async getMedia(filters: MediaFilters): Promise<MediaResponse> {
    const params = new URLSearchParams();
    if (filters.page !== undefined) params.set('page', String(filters.page));
    if (filters.limit !== undefined) params.set('limit', String(filters.limit));
    if (filters.type !== undefined) params.set('type', filters.type);
    if (filters.search !== undefined && filters.search !== '') params.set('search', filters.search);
    if (filters.jobId !== undefined && filters.jobId !== '') params.set('jobId', filters.jobId);
    return request<MediaResponse>(`/api/media?${params.toString()}`);
  },
};
