import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import type { MediaFilters, MediaResponse } from '../types.js';

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState<T>(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

export function useMedia(filters: MediaFilters): UseQueryResult<MediaResponse> {
  const queryClient = useQueryClient();
  const debouncedSearch = useDebounced(filters.search ?? '', 500);

  // While the user is still typing, hold the page at 1 so we don't fetch
  // the current page with a soon-to-be-stale search term.
  const isDebouncing = (filters.search ?? '') !== debouncedSearch;

  const effectiveFilters: MediaFilters = {
    ...filters,
    page: isDebouncing ? 1 : filters.page,
    search: debouncedSearch,
  };

  const queryKey = ['media', effectiveFilters] as const;

  const queryResult = useQuery({
    queryKey,
    queryFn: () => api.getMedia(effectiveFilters),
    // Don't show stale data while debouncing a new search term
    placeholderData: isDebouncing ? undefined : (prev) => prev,
    enabled: !isDebouncing,
  });

  // Prefetch next page — but only when the search input has settled.
  // Skipping during debounce prevents fetching page 2 for a stale search term.
  useEffect(() => {
    if (isDebouncing) return;
    if (!queryResult.data?.pagination) return;
    const { page, totalPages } = queryResult.data.pagination;
    if (page >= totalPages) return;

    const nextFilters: MediaFilters = { ...effectiveFilters, page: page + 1 };
    void queryClient.prefetchQuery({
      queryKey: ['media', nextFilters],
      queryFn: () => api.getMedia(nextFilters),
      staleTime: 30_000,
    });
  }, [
    isDebouncing,
    queryResult.data?.pagination?.page,
    queryResult.data?.pagination?.totalPages,
    effectiveFilters.limit,
    effectiveFilters.type,
    effectiveFilters.search,
    effectiveFilters.jobId,
    queryClient,
  ]);

  return queryResult;
}
