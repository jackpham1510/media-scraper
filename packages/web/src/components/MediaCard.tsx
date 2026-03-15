import type React from 'react';
import { useState } from 'react';
import { ImageOff, ExternalLink, ZoomIn } from 'lucide-react';
import type { MediaItem } from '../types.js';
import { Badge } from './ui/badge.js';

interface MediaCardProps {
  item: MediaItem;
  onClick?: () => void;
}

export function MediaCard({ item, onClick }: MediaCardProps): React.JSX.Element {
  const { mediaUrl, mediaType, altText, sourceUrl } = item;
  const [imgError, setImgError] = useState(false);

  let displayUrl: string;
  try {
    const u = new URL(sourceUrl);
    displayUrl = u.host + u.pathname + u.search + u.hash;
  } catch {
    displayUrl = sourceUrl.replace(/^https?:\/\//, '');
  }

  return (
    <div
      className="group overflow-hidden rounded-xl border border-border bg-card shadow-sm hover:shadow-md transition-all duration-200 cursor-pointer"
      onClick={onClick}
    >
      {/* Media area */}
      <div className="relative overflow-hidden bg-muted aspect-video">
        {mediaType === 'image' ? (
          imgError ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-muted-foreground">
              <ImageOff className="h-8 w-8 opacity-40" />
              <span className="text-xs">Image unavailable</span>
            </div>
          ) : (
            <img
              src={mediaUrl}
              alt={altText ?? ''}
              loading="lazy"
              className="absolute inset-0 h-full w-full object-scale-down transition-transform duration-300 group-hover:scale-105"
              onError={() => setImgError(true)}
            />
          )
        ) : (
          <video
            src={mediaUrl}
            preload="none"
            className="absolute inset-0 h-full w-full object-cover bg-black"
            onClick={(e) => e.stopPropagation()}
          />
        )}

        {/* Expand hint on hover */}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors duration-200 flex items-center justify-center">
          <ZoomIn className="h-8 w-8 text-white opacity-0 group-hover:opacity-80 transition-opacity duration-200 drop-shadow-lg" />
        </div>

        {/* Type badge overlay */}
        <div className="absolute top-2 right-2">
          <Badge
            variant={mediaType === 'image' ? 'secondary' : 'default'}
            className="text-xs shadow-sm"
          >
            {mediaType}
          </Badge>
        </div>
      </div>

      {/* Info area */}
      <div className="p-3 space-y-1.5">
        <a
          href={sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors group/link"
          title={sourceUrl}
        >
          <span className="truncate">{displayUrl}</span>
          <ExternalLink className="h-3 w-3 shrink-0 opacity-0 group-hover/link:opacity-100 transition-opacity" />
        </a>
        {altText !== null && altText !== '' && (
          <p className="text-xs text-foreground/70 truncate" title={altText}>
            {altText}
          </p>
        )}
      </div>
    </div>
  );
}
