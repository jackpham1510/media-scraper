import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '../api/client.js';
import type { JobListResponse, JobStatus } from '../types.js';

export function useJobs(
  status: 'active' | 'done',
  page: number,
  options?: { enabled?: boolean },
): ReturnType<typeof useQuery<JobListResponse>> {
  const queryClient = useQueryClient();
  const prevJobsRef = useRef<Map<string, JobStatus>>(new Map());

  const query = useQuery<JobListResponse>({
    queryKey: ['jobList', status, page],
    queryFn: () => api.getJobs(status, page),
    refetchInterval: status === 'active' ? 3000 : undefined,
    staleTime: status === 'done' ? Infinity : 0,
    retry: false,
    enabled: options?.enabled !== false,
  });

  // Detect active jobs that have left the list (completed/failed) and fire side effects
  useEffect(() => {
    if (status !== 'active' || query.data === undefined) return;

    const currentIds = new Set(query.data.data.map((j) => j.jobId));
    const prev = prevJobsRef.current;

    let anyDeparted = false;
    for (const [jobId, lastKnown] of prev) {
      if (!currentIds.has(jobId)) {
        anyDeparted = true;
        if (lastKnown.status === 'failed') {
          toast.error('Job failed', { description: `Job ${jobId.slice(0, 8)}… failed` });
        } else {
          toast.success('Job completed', { description: `Job ${jobId.slice(0, 8)}… finished` });
        }
      }
    }
    if (anyDeparted) {
      void queryClient.invalidateQueries({ queryKey: ['media'] });
    }

    // Update snapshot
    const next = new Map<string, JobStatus>();
    for (const job of query.data.data) {
      next.set(job.jobId, job);
    }
    prevJobsRef.current = next;
  }, [query.data, status, queryClient]);

  return query;
}
