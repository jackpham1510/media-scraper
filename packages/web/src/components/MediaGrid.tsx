import type React from 'react';
import type { MediaItem } from '../types.js';
import { MediaCard } from './MediaCard.js';
import { ImageOff } from 'lucide-react';
import { cn } from '../lib/utils.js';

interface MediaGridProps {
  items: MediaItem[];
  isLoading: boolean;
  isUpdating?: boolean;
  onItemClick?: (index: number) => void;
}

function LoadingSkeleton(): React.JSX.Element {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div className="aspect-video w-full animate-pulse bg-muted" />
      <div className="p-3 space-y-2">
        <div className="h-3 w-2/3 animate-pulse rounded-full bg-muted" />
        <div className="h-3 w-1/2 animate-pulse rounded-full bg-muted" />
      </div>
    </div>
  );
}

export function MediaGrid({ items, isLoading, isUpdating, onItemClick }: MediaGridProps): React.JSX.Element {
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
      <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground">
        <ImageOff className="h-12 w-12 opacity-30" />
        <p className="text-sm">No media found</p>
      </div>
    );
  }

  return (
    <div className={cn('relative', isUpdating && 'opacity-60 pointer-events-none transition-opacity')}>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {items.map((item, i) => (
          <MediaCard key={item.id} item={item} onClick={() => onItemClick?.(i)} />
        ))}
      </div>
    </div>
  );
}
