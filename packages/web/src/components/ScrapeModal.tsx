import type React from 'react';
import { useState } from 'react';
import { Loader2, Globe } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useJobStatus } from '../hooks/useJobStatus.js';
import { Button } from './ui/button.js';
import { Textarea } from './ui/textarea.js';
import { Label } from './ui/label.js';
import { Input } from './ui/input.js';
import { Checkbox } from './ui/checkbox.js';
import { Progress } from './ui/progress.js';
import { Badge } from './ui/badge.js';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose,
} from './ui/dialog.js';
import type { JobStatusValue } from '../types.js';

interface ScrapeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onJobStarted: (jobId: string) => void;
}

function statusLabel(s: JobStatusValue): string {
  switch (s) {
    case 'pending': return 'Pending';
    case 'running': return 'Running';
    case 'fast_complete': return 'Processing SPAs';
    case 'done': return 'Done';
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

export function ScrapeModal({ open, onOpenChange, onJobStarted }: ScrapeModalProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const [urlsText, setUrlsText] = useState('');
  const [browserFallback, setBrowserFallback] = useState(false);
  const [maxScrollDepth, setMaxScrollDepth] = useState(10);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  const { data: jobStatus } = useJobStatus(activeJobId);

  const handleClose = (nextOpen: boolean): void => {
    if (!nextOpen) {
      // Reset form when closing (unless job is still running)
      if (!activeJobId || jobStatus?.status === 'done' || jobStatus?.status === 'failed') {
        setUrlsText('');
        setError(null);
        setActiveJobId(null);
        setBrowserFallback(false);
        setMaxScrollDepth(10);
      }
    }
    onOpenChange(nextOpen);
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setError(null);

    const urls = urlsText
      .split('\n')
      .map((u) => u.trim())
      .filter((u) => u.length > 0);

    if (urls.length === 0) {
      setError('Please enter at least one URL.');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await api.scrape(urls, {
        browserFallback,
        ...(browserFallback ? { maxScrollDepth } : {}),
      });
      setActiveJobId(result.jobId);
      onJobStarted(result.jobId);
      toast.info('Scrape job started', { description: `${urls.length} URL${urls.length !== 1 ? 's' : ''} queued` });
    } catch {
      setError('Failed to start scrape job. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const progress = jobStatus
    ? Math.round((jobStatus.urlsDone / Math.max(jobStatus.urlsTotal, 1)) * 100)
    : 0;

  const isJobActive = activeJobId !== null && jobStatus !== undefined && jobStatus.status !== 'done' && jobStatus.status !== 'failed';
  const isFormDisabled = isSubmitting || isJobActive;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Globe className="h-5 w-5 text-primary" />
            Scrape URLs
          </DialogTitle>
        </DialogHeader>

        {activeJobId === null ? (
          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="urls">URLs to scrape (one per line)</Label>
              <Textarea
                id="urls"
                rows={6}
                value={urlsText}
                onChange={(e) => setUrlsText(e.target.value)}
                placeholder={'https://example.com\nhttps://another.com'}
                className="font-mono text-xs resize-y"
                disabled={isFormDisabled}
              />
            </div>

            <div className="flex items-center gap-3">
              <Checkbox
                id="browserFallback"
                checked={browserFallback}
                onCheckedChange={(v) => setBrowserFallback(v === true)}
                disabled={isFormDisabled}
              />
              <Label htmlFor="browserFallback" className="cursor-pointer">
                Browser fallback (for SPAs)
              </Label>
            </div>

            {browserFallback && (
              <div className="flex items-center gap-3">
                <Label htmlFor="maxScrollDepth" className="whitespace-nowrap">Max scroll depth</Label>
                <Input
                  id="maxScrollDepth"
                  type="number"
                  min={1}
                  max={60}
                  value={maxScrollDepth}
                  onChange={(e) => setMaxScrollDepth(Number(e.target.value))}
                  className="w-24"
                  disabled={isFormDisabled}
                />
              </div>
            )}

            {error !== null && (
              <p className="text-sm text-destructive">{error}</p>
            )}

            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">Cancel</Button>
              </DialogClose>
              <Button type="submit" disabled={isFormDisabled}>
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {isSubmitting ? 'Starting...' : 'Scrape URLs'}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground font-mono">
                {activeJobId.slice(0, 8)}…
              </span>
              {jobStatus && (
                <Badge variant={statusVariant(jobStatus.status)}>
                  {statusLabel(jobStatus.status)}
                </Badge>
              )}
            </div>

            {jobStatus && (
              <>
                <Progress value={progress} className="h-2" />
                <p className="text-sm text-muted-foreground">
                  {jobStatus.urlsDone} / {jobStatus.urlsTotal} URLs done
                  {jobStatus.urlsSpaDetected > 0 && ` · ${jobStatus.urlsBrowserPending} SPA pending`}
                </p>
              </>
            )}

            {jobStatus?.status === 'done' && (
              <div className="rounded-md bg-emerald-50 border border-emerald-200 p-3 text-sm text-emerald-800">
                Scraping complete! Results are now in the gallery.
              </div>
            )}

            {jobStatus?.status === 'failed' && (
              <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-800">
                Scraping failed.
              </div>
            )}

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setActiveJobId(null);
                  setUrlsText('');
                }}
              >
                {jobStatus?.status === 'done' || jobStatus?.status === 'failed' ? 'Close' : 'New Scrape'}
              </Button>
              {(jobStatus?.status === 'done' || jobStatus?.status === 'failed') && (
                <Button onClick={() => {
                  void queryClient.invalidateQueries({ queryKey: ['media'] });
                  onOpenChange(false);
                }}>View Gallery</Button>
              )}
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
