import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';

export function useJobStats(): { activeCount: number } {
  const { data } = useQuery({
    queryKey: ['jobStats'],
    queryFn: () => api.getJobStats(),
    refetchInterval: 3000,
    retry: false,
  });
  return { activeCount: data?.activeCount ?? 0 };
}
