import { useQuery } from '@tanstack/react-query';
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
  const debouncedSearch = useDebounced(filters.search ?? '', 500);

  // While the user is still typing, hold the page at 1 and disable the query
  // so we never fetch a page with a soon-to-be-stale search term.
  const isDebouncing = (filters.search ?? '') !== debouncedSearch;

  const effectiveFilters: MediaFilters = {
    ...filters,
    page: isDebouncing ? 1 : filters.page,
    search: debouncedSearch,
  };

  return useQuery({
    queryKey: ['media', effectiveFilters] as const,
    queryFn: () => api.getMedia(effectiveFilters),
    placeholderData: isDebouncing ? undefined : (prev) => prev,
    enabled: !isDebouncing,
  });
}
