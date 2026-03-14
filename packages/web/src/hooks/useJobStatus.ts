import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { api } from '../api/client.js';
import type { JobStatus } from '../types.js';

const ACTIVE_STATUSES = new Set<string>(['pending', 'running', 'fast_complete']);

export function useJobStatus(jobId: string | null): UseQueryResult<JobStatus> {
  return useQuery({
    queryKey: ['jobStatus', jobId],
    queryFn: async () => {
      if (!jobId) throw new Error('No jobId provided');
      return api.getJobStatus(jobId);
    },
    enabled: jobId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === undefined) return 2000;
      return ACTIVE_STATUSES.has(status) ? 2000 : false;
    },
  });
}
