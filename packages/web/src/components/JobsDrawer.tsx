import type React from 'react';
import { useState } from 'react';
import { Inbox, ChevronLeft, ChevronRight } from 'lucide-react';
import { useJobs } from '../hooks/useJobs.js';
import type { JobStatus, JobStatusValue } from '../types.js';
import { Progress } from './ui/progress.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { cn } from '../lib/utils.js';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from './ui/sheet.js';

type Tab = 'active' | 'done';

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

function JobRow({ job }: { job: JobStatus }): React.JSX.Element {
  const progress = Math.round((job.urlsDone / Math.max(job.urlsTotal, 1)) * 100);
  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-mono text-muted-foreground truncate flex-1">
          {job.jobId.slice(0, 12)}…
        </span>
        <Badge variant={statusVariant(job.status)} className="text-xs">
          {statusLabel(job.status)}
        </Badge>
      </div>
      <Progress value={progress} className="h-1.5" />
      <p className="text-xs text-muted-foreground">
        {job.urlsDone} / {job.urlsTotal} URLs
        {job.urlsBrowserPending > 0 && ` · ${job.urlsBrowserPending} SPA pending`}
      </p>
      {job.finishedAt !== null && (
        <p className="text-xs text-muted-foreground">
          Finished {new Date(job.finishedAt).toLocaleTimeString()}
        </p>
      )}
    </div>
  );
}

function PaginationControls({
  page,
  totalPages,
  onPage,
}: {
  page: number;
  totalPages: number;
  onPage: (p: number) => void;
}): React.JSX.Element | null {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-center gap-1 pt-2 border-t">
      <Button
        variant="outline"
        size="icon"
        className="h-7 w-7"
        onClick={() => onPage(Math.max(1, page - 1))}
        disabled={page === 1}
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </Button>
      <span className="text-xs text-muted-foreground px-2">
        {page} / {totalPages}
      </span>
      <Button
        variant="outline"
        size="icon"
        className="h-7 w-7"
        onClick={() => onPage(Math.min(totalPages, page + 1))}
        disabled={page === totalPages}
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

export interface JobsDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function JobsDrawer({ open, onOpenChange }: JobsDrawerProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<Tab>('active');
  const [historyEverOpened, setHistoryEverOpened] = useState(false);

  const [activePage, setActivePage] = useState(1);
  const [historyPage, setHistoryPage] = useState(1);

  const activeQuery = useJobs('active', activePage);
  const historyQuery = useJobs('done', historyPage, { enabled: historyEverOpened });

  const handleTabChange = (tab: Tab): void => {
    setActiveTab(tab);
    if (tab === 'done') {
      if (!historyEverOpened) setHistoryEverOpened(true);
      setHistoryPage(1);
    }
  };

  const currentQuery = activeTab === 'active' ? activeQuery : historyQuery;
  const jobs = currentQuery.data?.data ?? [];
  const totalPages = currentQuery.data?.pagination.totalPages ?? 1;
  const page = activeTab === 'active' ? activePage : historyPage;
  const setPage = activeTab === 'active' ? setActivePage : setHistoryPage;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-80 sm:max-w-sm flex flex-col">
        <SheetHeader>
          <SheetTitle>Activity</SheetTitle>
        </SheetHeader>

        {/* Tab bar */}
        <div className="flex gap-1 mt-3 rounded-lg bg-muted p-1" role="tablist">
          {(['active', 'done'] as Tab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              onClick={() => handleTabChange(tab)}
              className={cn(
                'flex-1 px-3 py-1 rounded-md text-sm font-medium transition-colors',
                activeTab === tab
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {tab === 'active' ? 'Active' : 'History'}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex flex-col flex-1 min-h-0 mt-3 gap-3">
          {currentQuery.isLoading ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <p className="text-sm animate-pulse">Loading…</p>
            </div>
          ) : currentQuery.isError && jobs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <p className="text-sm text-destructive">Failed to load jobs</p>
            </div>
          ) : jobs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground space-y-2">
              <Inbox className="h-8 w-8 opacity-40" />
              <p className="text-sm">
                {activeTab === 'active' ? 'No active jobs' : 'No completed jobs'}
              </p>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto space-y-3">
              {jobs.map((job) => <JobRow key={job.jobId} job={job} />)}
            </div>
          )}

          <PaginationControls page={page} totalPages={totalPages} onPage={setPage} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
