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

  const result = useQuery({
    queryKey,
    queryFn: () => api.getMedia(effectiveFilters),
    placeholderData: (prev) => prev,
  });

  // Prefetch next page
  useEffect(() => {
    const { data } = result;
    if (!data) return;

    const currentPage = effectiveFilters.page ?? 1;
    if (currentPage < data.pagination.totalPages) {
      const nextFilters: MediaFilters = { ...effectiveFilters, page: currentPage + 1 };
      void queryClient.prefetchQuery({
        queryKey: ['media', nextFilters],
        queryFn: () => api.getMedia(nextFilters),
      });
    }
  }, [result.data, effectiveFilters, queryClient]);

  return result;
}
