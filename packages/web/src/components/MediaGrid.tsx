import type React from 'react';
import type { MediaItem } from '../types.js';
import { MediaCard } from './MediaCard.js';

interface MediaGridProps {
  items: MediaItem[];
  isLoading: boolean;
  isUpdating?: boolean;
}

function LoadingSkeleton(): React.JSX.Element {
  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
      <div className="h-48 w-full animate-pulse bg-gray-200 rounded-t-lg" />
      <div className="p-3 space-y-2">
        <div className="h-3 w-3/4 animate-pulse rounded bg-gray-200" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-gray-200" />
      </div>
    </div>
  );
}

export function MediaGrid({ items, isLoading, isUpdating }: MediaGridProps): React.JSX.Element {
  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <LoadingSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-500">
        <p className="text-lg">No media found</p>
      </div>
    );
  }

  return (
    <div className="relative">
      {isUpdating && (
        <div className="absolute inset-0 bg-white/50 z-10 flex items-center justify-center">
          <div className="text-gray-500 text-sm">Loading...</div>
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {items.map((item) => (
          <MediaCard key={item.id} item={item} />
        ))}
      </div>
    </div>
  );
}
