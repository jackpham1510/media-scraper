import type React from 'react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { MediaGrid } from '../components/MediaGrid.js';
import { useMedia } from '../hooks/useMedia.js';
import type { MediaFilters } from '../types.js';

export function GalleryPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const jobId = searchParams.get('jobId') ?? undefined;

  const [typeFilter, setTypeFilter] = useState<'image' | 'video' | undefined>(undefined);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const filters: MediaFilters = {
    page,
    limit: 20,
    type: typeFilter,
    search,
    jobId,
  };

  const { data, isLoading, isFetching, isError } = useMedia(filters);

  const handleTypeChange = (t: 'image' | 'video' | undefined): void => {
    setTypeFilter(t);
    setPage(1);
  };

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>): void => {
    setSearch(e.target.value);
    setPage(1);
  };

  const totalPages = data?.pagination.totalPages ?? 1;
  const totalItems = data?.pagination.total ?? 0;

  const renderPageNumbers = (): React.JSX.Element[] => {
    const pages: React.JSX.Element[] = [];
    const maxVisible = 7;

    if (totalPages <= maxVisible) {
      for (let p = 1; p <= totalPages; p++) {
        pages.push(
          <button
            key={p}
            onClick={() => setPage(p)}
            className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
              p === page
                ? 'bg-blue-600 text-white'
                : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50'
            }`}
          >
            {p}
          </button>,
        );
      }
    } else {
      // Show first, last, and pages around current
      const surroundStart = Math.max(2, page - 1);
      const surroundEnd = Math.min(totalPages - 1, page + 1);

      pages.push(
        <button
          key={1}
          onClick={() => setPage(1)}
          className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
            page === 1
              ? 'bg-blue-600 text-white'
              : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50'
          }`}
        >
          1
        </button>,
      );

      if (surroundStart > 2) {
        pages.push(<span key="start-ellipsis" className="px-2 text-gray-400">...</span>);
      }

      for (let p = surroundStart; p <= surroundEnd; p++) {
        pages.push(
          <button
            key={p}
            onClick={() => setPage(p)}
            className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
              p === page
                ? 'bg-blue-600 text-white'
                : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50'
            }`}
          >
            {p}
          </button>,
        );
      }

      if (surroundEnd < totalPages - 1) {
        pages.push(<span key="end-ellipsis" className="px-2 text-gray-400">...</span>);
      }

      pages.push(
        <button
          key={totalPages}
          onClick={() => setPage(totalPages)}
          className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
            page === totalPages
              ? 'bg-blue-600 text-white'
              : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50'
          }`}
        >
          {totalPages}
        </button>,
      );
    }

    return pages;
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center gap-4">
        <button
          onClick={() => navigate('/')}
          className="text-sm text-blue-600 hover:text-blue-800 font-medium flex items-center gap-1"
        >
          &larr; Back
        </button>
        <h1 className="text-2xl font-bold text-gray-900">Media Gallery</h1>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6 space-y-6">
        {/* Filter bar */}
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          {/* Type toggles */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => handleTypeChange(undefined)}
              className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                typeFilter === undefined
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              All
            </button>
            <button
              onClick={() => handleTypeChange('image')}
              className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                typeFilter === 'image'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              Images
            </button>
            <button
              onClick={() => handleTypeChange('video')}
              className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                typeFilter === 'video'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              Videos
            </button>
          </div>

          {/* Search */}
          <div className="flex-1 min-w-40">
            <input
              type="text"
              placeholder="Search..."
              value={search}
              onChange={handleSearch}
              className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          {/* Total count */}
          {!isLoading && (
            <span className="text-sm text-gray-500 whitespace-nowrap">
              {totalItems} media item{totalItems !== 1 ? 's' : ''} found
            </span>
          )}
          {isFetching && !isLoading && (
            <span className="text-sm text-gray-500 animate-pulse">Updating...</span>
          )}
        </div>

        {/* Error state */}
        {isError && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700 text-sm">
            Failed to load media. Please try again.
          </div>
        )}

        {/* Grid */}
        <MediaGrid items={data?.data ?? []} isLoading={isLoading} isUpdating={isFetching && !isLoading} />

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 pt-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-3 py-1 rounded text-sm font-medium bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              &lsaquo; Prev
            </button>
            {renderPageNumbers()}
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="px-3 py-1 rounded text-sm font-medium bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Next &rsaquo;
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
