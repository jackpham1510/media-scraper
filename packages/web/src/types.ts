export type JobStatusValue = 'pending' | 'running' | 'fast_complete' | 'done' | 'failed';

export interface JobStatus {
  jobId: string;
  status: JobStatusValue;
  urlsTotal: number;
  urlsDone: number;
  urlsSpaDetected: number;
  urlsBrowserDone: number;
  urlsBrowserPending: number;
  createdAt: string;
  finishedAt: string | null;
}

export interface MediaItem {
  id: string;
  pageId: string;
  jobId: string;
  sourceUrl: string;
  mediaUrl: string;
  mediaType: 'image' | 'video';
  altText: string | null;
  createdAt: string;
}

export interface MediaFilters {
  page?: number;
  limit?: number;
  type?: 'image' | 'video' | undefined;
  search?: string;
  jobId?: string;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface MediaResponse {
  data: MediaItem[];
  pagination: Pagination;
}

export interface JobListResponse {
  data: JobStatus[];
  pagination: Pagination;
}
