import { useState, useCallback } from 'react';

export interface TrackedJob {
  jobId: string;
  addedAt: number;
}

interface UseActiveJobsReturn {
  trackedJobs: TrackedJob[];
  addJob: (jobId: string) => void;
  removeJob: (jobId: string) => void;
}

export function useActiveJobs(): UseActiveJobsReturn {
  const [trackedJobs, setTrackedJobs] = useState<TrackedJob[]>([]);

  const addJob = useCallback((jobId: string) => {
    setTrackedJobs((prev) => {
      if (prev.some((j) => j.jobId === jobId)) return prev;
      return [...prev, { jobId, addedAt: Date.now() }];
    });
  }, []);

  const removeJob = useCallback((jobId: string) => {
    setTrackedJobs((prev) => prev.filter((j) => j.jobId !== jobId));
  }, []);

  return { trackedJobs, addJob, removeJob };
}
