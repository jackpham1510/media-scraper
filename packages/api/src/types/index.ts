// Job status machine: pending → running → fast_complete → done
// fast_complete: fast queue finished, browser queue still has pending URLs
export type JobStatus = 'pending' | 'running' | 'fast_complete' | 'done' | 'failed';

export type UrlStatus = 'pending' | 'processing' | 'spa_detected' | 'done' | 'failed';

export type MediaType = 'image' | 'video';

export type ScrapePath = 'fast' | 'browser';

export interface SpaSignals {
  hasRootDiv: boolean;
  hasNextData: boolean;
  hasNuxtData: boolean;
  hasNoScriptWarning: boolean;
  bodyTextLength: number;
  scriptTagCount: number;
  mediaCount: number;
}

export interface ParsedPage {
  title: string | null;
  description: string | null;
  rawHtml: string;
  mediaItems: Array<{
    mediaUrl: string;
    mediaType: MediaType;
    altText: string | null;
  }>;
  spaSignals: SpaSignals;
}

export interface FastJobPayload {
  jobId: string;
  browserFallback: boolean;
  maxScrollDepth: number;
  urls: Array<{ id: number; url: string }>;
}

export interface BrowserJobPayload {
  jobId: string;
  requestId: number;
  url: string;
  maxScrollDepth: number;
}

export interface MediaInput {
  pageId: bigint;
  jobId: string;
  sourceUrl: string;
  mediaUrl: string;
  mediaUrlHash: string;
  mediaType: MediaType;
  altText: string | null;
}
