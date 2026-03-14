import type React from 'react';
import { useEffect, useRef } from 'react';
import { X, Inbox } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { useJobStatus } from '../hooks/useJobStatus.js';
import type { TrackedJob } from '../hooks/useActiveJobs.js';
import type { JobStatusValue } from '../types.js';
import { Progress } from './ui/progress.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from './ui/sheet.js';

interface JobRowProps {
  trackedJob: TrackedJob;
  onRemove: (jobId: string) => void;
}

function statusLabel(s: JobStatusValue): string {
  switch (s) {
    case 'pending': return 'Pending';
    case 'running': return 'Running';
    case 'fast_complete': return 'Processing SPAs';
    case 'done': return 'Complete';
    case 'failed': return 'Failed';
  }
}

function statusVariant(s: JobStatusValue): 'default' | 'secondary' | 'warning' | 'success' | 'destructive' {
  switch (s) {
    case 'pending': return 'secondary';
    case 'running': return 'warning';
    case 'fast_complete': return 'warning';
    case 'done': return 'success';
    case 'failed': return 'destructive';
  }
}

function JobRow({ trackedJob, onRemove }: JobRowProps): React.JSX.Element {
  const { jobId } = trackedJob;
  const { data: status } = useJobStatus(jobId);
  const prevStatusRef = useRef<JobStatusValue | undefined>(undefined);
  const queryClient = useQueryClient();

  useEffect(() => {
    const current = status?.status;
    const prev = prevStatusRef.current;
    if (current !== undefined && current !== prev && prev !== undefined) {
      if (current === 'done') {
        toast.success('Scraping complete', {
          description: `Job ${jobId.slice(0, 8)}… finished — ${status?.urlsDone ?? 0} URLs scraped`,
        });
        void queryClient.invalidateQueries({ queryKey: ['media'] });
      } else if (current === 'failed') {
        toast.error('Scraping failed', { description: `Job ${jobId.slice(0, 8)}…` });
      }
    }
    prevStatusRef.current = current;
  }, [status?.status, jobId, status?.urlsDone]);

  const progress = status ? Math.round((status.urlsDone / Math.max(status.urlsTotal, 1)) * 100) : 0;
  const isDone = status?.status === 'done' || status?.status === 'failed';

  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-mono text-muted-foreground truncate flex-1">
          {jobId.slice(0, 12)}…
        </span>
        <div className="flex items-center gap-1.5">
          {status && (
            <Badge variant={statusVariant(status.status)} className="text-xs">
              {statusLabel(status.status)}
            </Badge>
          )}
          {isDone && (
            <button
              onClick={() => onRemove(jobId)}
              className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground hover:bg-accent"
              aria-label="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {status && (
        <>
          <Progress value={progress} className="h-1.5" />
          <p className="text-xs text-muted-foreground">
            {status.urlsDone} / {status.urlsTotal} URLs
            {status.urlsSpaDetected > 0 && ` · ${status.urlsBrowserPending} SPA pending`}
          </p>
        </>
      )}
    </div>
  );
}

interface JobsDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trackedJobs: TrackedJob[];
  onRemoveJob: (jobId: string) => void;
}

export function JobsDrawer({ open, onOpenChange, trackedJobs, onRemoveJob }: JobsDrawerProps): React.JSX.Element {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-80 sm:max-w-sm flex flex-col">
        <SheetHeader>
          <SheetTitle>Activity</SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto mt-4 space-y-3">
          {trackedJobs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground space-y-2">
              <Inbox className="h-8 w-8 opacity-40" />
              <p className="text-sm">No active jobs</p>
            </div>
          ) : (
            trackedJobs.map((job) => (
              <JobRow key={job.jobId} trackedJob={job} onRemove={onRemoveJob} />
            ))
          )}
        </div>

        {trackedJobs.length > 0 && (
          <div className="pt-3 border-t">
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => {
                trackedJobs.forEach((j) => onRemoveJob(j.jobId));
              }}
            >
              Clear All
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
