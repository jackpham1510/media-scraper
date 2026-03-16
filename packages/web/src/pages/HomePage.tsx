import type React from 'react';
import { useState } from 'react';
import { Plus, Briefcase, Search, Globe, ChevronLeft, ChevronRight } from 'lucide-react';
import { useMedia } from '../hooks/useMedia.js';
import type { MediaFilters } from '../types.js';
import { MediaGrid } from '../components/MediaGrid.js';
import { MediaLightbox } from '../components/MediaLightbox.js';
import { ScrapeModal } from '../components/ScrapeModal.js';
import { JobsDrawer } from '../components/JobsDrawer.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { cn } from '../lib/utils.js';

type TypeFilter = 'image' | 'video' | undefined;

export function HomePage(): React.JSX.Element {
  const [scrapeOpen, setScrapeOpen] = useState(false);
  const [jobsOpen, setJobsOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const [typeFilter, setTypeFilter] = useState<TypeFilter>(undefined);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const filters: MediaFilters = {
    page,
    limit: 20,
    type: typeFilter,
    search,
  };

  const { data, isLoading, isFetching, isError } = useMedia(filters);

  const totalPages = data?.pagination.totalPages ?? 1;
  const totalItems = data?.pagination.total ?? 0;

  const handleTypeChange = (t: TypeFilter): void => {
    setTypeFilter(t);
    setPage(1);
  };

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>): void => {
    setSearch(e.target.value);
    setPage(1);
  };

  // Pagination helpers
  const renderPageNumbers = (): React.JSX.Element[] => {
    const pages: React.JSX.Element[] = [];
    const maxVisible = 7;

    const addPageBtn = (p: number): void => {
      pages.push(
        <button
          key={p}
          onClick={() => setPage(p)}
          className={cn(
            'h-8 w-8 rounded-md text-sm font-medium transition-colors',
            p === page
              ? 'bg-primary text-primary-foreground'
              : 'border border-border text-foreground hover:bg-accent',
          )}
        >
          {p}
        </button>,
      );
    };

    if (totalPages <= maxVisible) {
      for (let p = 1; p <= totalPages; p++) addPageBtn(p);
    } else {
      addPageBtn(1);
      const surroundStart = Math.max(2, page - 1);
      const surroundEnd = Math.min(totalPages - 1, page + 1);
      if (surroundStart > 2) pages.push(<span key="e1" className="px-1 text-muted-foreground">…</span>);
      for (let p = surroundStart; p <= surroundEnd; p++) addPageBtn(p);
      if (surroundEnd < totalPages - 1) pages.push(<span key="e2" className="px-1 text-muted-foreground">…</span>);
      addPageBtn(totalPages);
    }
    return pages;
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          {/* Brand */}
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-md bg-primary flex items-center justify-center">
              <Globe className="h-4 w-4 text-primary-foreground" />
            </div>
            <span className="font-bold text-lg tracking-tight">
              Media<span className="text-primary">Scraper</span>
            </span>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setJobsOpen(true)}
              className="gap-2"
            >
              <Briefcase className="h-4 w-4" />
              <span className="hidden sm:inline">Activity</span>
            </Button>
            <Button size="sm" onClick={() => setScrapeOpen(true)} className="gap-2">
              <Plus className="h-4 w-4" />
              <span>New Scrape</span>
            </Button>
          </div>
        </div>
      </header>

      {/* Filters */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4">
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-3 shadow-sm">
          {/* Type toggles */}
          <div className="flex items-center gap-1 rounded-lg bg-muted p-1">
            {([undefined, 'image', 'video'] as TypeFilter[]).map((t) => (
              <button
                key={String(t)}
                onClick={() => handleTypeChange(t)}
                className={cn(
                  'px-3 py-1 rounded-md text-sm font-medium transition-colors',
                  typeFilter === t
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t === undefined ? 'All' : t === 'image' ? 'Images' : 'Videos'}
              </button>
            ))}
          </div>

          {/* Search — matches alt text or source URL */}
          <div className="relative flex-1 min-w-48">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search by alt text or URL…"
              value={search}
              onChange={handleSearch}
              className="pl-8 h-9"
            />
          </div>

          {/* Count */}
          <span className="text-sm text-muted-foreground whitespace-nowrap ml-auto">
            {isLoading ? '…' : `${totalItems.toLocaleString()} item${totalItems !== 1 ? 's' : ''}`}
            {isFetching && !isLoading && (
              <span className="ml-1 animate-pulse text-xs">updating</span>
            )}
          </span>
        </div>
      </div>

      {/* Main content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 pb-8 space-y-4">
        {isError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-destructive text-sm">
            Failed to load media. Please try again.
          </div>
        )}

        <MediaGrid
          items={data?.data ?? []}
          isLoading={isLoading}
          isUpdating={isFetching && !isLoading}
          onItemClick={(i) => setLightboxIndex(i)}
        />

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-1.5 pt-2">
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            {renderPageNumbers()}
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        )}
      </main>

      {/* Modals */}
      <ScrapeModal
        open={scrapeOpen}
        onOpenChange={setScrapeOpen}
      />

      <JobsDrawer
        open={jobsOpen}
        onOpenChange={setJobsOpen}
      />

      {lightboxIndex !== null && data?.data !== undefined && data.data.length > 0 && (
        <MediaLightbox
          items={data.data}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </div>
  );
}
