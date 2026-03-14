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
  const debouncedSearch = useDebounced(filters.search ?? '', 300);

  const effectiveFilters: MediaFilters = {
    ...filters,
    search: debouncedSearch,
  };

  const queryKey = ['media', effectiveFilters] as const;

  const queryResult = useQuery({
    queryKey,
    queryFn: () => api.getMedia(effectiveFilters),
    placeholderData: (prev) => prev,
  });

  // Prefetch next page when data is available and there are more pages.
  // Depend on stable primitives instead of the effectiveFilters object reference
  // to avoid firing on every render.
  useEffect(() => {
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
