import type React from 'react';
import { useJobStatus } from '../hooks/useJobStatus.js';
import type { JobStatusValue } from '../types.js';

interface JobStatusProps {
  jobId: string;
}

const STATUS_LABELS: Record<JobStatusValue, string> = {
  pending: 'Pending',
  running: 'Running',
  fast_complete: 'Processing SPAs',
  done: 'Done',
  failed: 'Failed',
};

const STATUS_COLORS: Record<JobStatusValue, string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  running: 'bg-blue-100 text-blue-800',
  fast_complete: 'bg-purple-100 text-purple-800',
  done: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
};

export function JobStatus({ jobId }: JobStatusProps): React.JSX.Element {
  const { data, isLoading, isError } = useJobStatus(jobId);

  if (isLoading) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="h-4 w-32 animate-pulse rounded bg-gray-200" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">
        Failed to load job status.
      </div>
    );
  }

  const { status, urlsDone, urlsTotal, urlsSpaDetected, urlsBrowserPending } = data;
  const progressPct = urlsTotal > 0 ? Math.round((urlsDone / urlsTotal) * 100) : 0;

  if (status === 'done') {
    return (
      <div className="rounded-lg border border-green-200 bg-green-50 p-4">
        <div className="flex items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_COLORS[status]}`}>
            {STATUS_LABELS[status]}
          </span>
          <span className="text-green-800 font-medium">
            Complete! {urlsDone} URL{urlsDone !== 1 ? 's' : ''} scraped.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-700">Job Progress</span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_COLORS[status]}`}>
          {STATUS_LABELS[status]}
        </span>
      </div>

      {/* Progress bar */}
      <div className="w-full rounded-full bg-gray-200 h-2">
        <div
          className="h-2 rounded-full bg-blue-500 transition-all duration-500"
          style={{ width: `${progressPct}%` }}
        />
      </div>

      {/* Counters */}
      <div className="flex flex-wrap gap-4 text-sm text-gray-600">
        <span>
          <span className="font-semibold text-gray-900">{urlsDone}</span> / {urlsTotal} URLs scraped
        </span>
        {urlsSpaDetected > 0 && (
          <span>
            <span className="font-semibold text-purple-700">{urlsSpaDetected}</span> SPAs detected
          </span>
        )}
        {urlsBrowserPending > 0 && (
          <span>
            <span className="font-semibold text-orange-600">{urlsBrowserPending}</span> browser URLs pending
          </span>
        )}
      </div>

      {status === 'failed' && (
        <p className="text-sm text-red-600">This job encountered an error.</p>
      )}
    </div>
  );
}
