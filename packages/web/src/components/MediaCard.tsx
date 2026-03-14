import type React from 'react';
import type { MediaItem } from '../types.js';

interface MediaCardProps {
  item: MediaItem;
}

export function MediaCard({ item }: MediaCardProps): React.JSX.Element {
  const { mediaUrl, mediaType, altText, sourceUrl } = item;

  // Truncate source URL for display
  let displayUrl: string;
  try {
    const parsed = new URL(sourceUrl);
    displayUrl = parsed.hostname + parsed.pathname;
    if (displayUrl.length > 50) {
      displayUrl = displayUrl.slice(0, 47) + '...';
    }
  } catch {
    displayUrl = sourceUrl.slice(0, 50);
  }

  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm hover:shadow-md transition-shadow">
      {mediaType === 'image' ? (
        <img
          src={mediaUrl}
          alt={altText ?? ''}
          loading="lazy"
          className="w-full h-48 object-cover rounded-t-lg bg-gray-100"
          onError={(e) => {
            const target = e.currentTarget;
            target.style.display = 'none';
          }}
        />
      ) : (
        <video
          src={mediaUrl}
          controls
          className="w-full h-48 object-cover rounded-t-lg bg-gray-900"
        />
      )}
      <div className="p-3 space-y-1">
        <p className="text-xs text-gray-500 truncate" title={sourceUrl}>
          {displayUrl}
        </p>
        {altText && (
          <p className="text-xs text-gray-700 truncate" title={altText}>
            {altText}
          </p>
        )}
        <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${
          mediaType === 'image'
            ? 'bg-blue-50 text-blue-700'
            : 'bg-purple-50 text-purple-700'
        }`}>
          {mediaType}
        </span>
      </div>
    </div>
  );
}
