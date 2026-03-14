import type React from 'react';
import { useState, useEffect, useRef, useCallback } from 'react';
import { X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, RotateCcw, ExternalLink, ImageOff } from 'lucide-react';
import type { MediaItem } from '../types.js';
import { cn } from '../lib/utils.js';

interface MediaLightboxProps {
  items: MediaItem[];
  initialIndex: number;
  onClose: () => void;
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.25;

export function MediaLightbox({ items, initialIndex, onClose }: MediaLightboxProps): React.JSX.Element {
  const [index, setIndex] = useState(initialIndex);
  const [zoom, setZoom] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const [imgError, setImgError] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);

  const dragRef = useRef<{ startX: number; startY: number; tx: number; ty: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const item = items[index];

  // Reset state when item changes
  useEffect(() => {
    setZoom(1);
    setTranslate({ x: 0, y: 0 });
    setImgError(false);
    setImgLoaded(false);
  }, [index]);

  const goNext = useCallback(() => {
    setIndex((i) => (i + 1) % items.length);
  }, [items.length]);

  const goPrev = useCallback(() => {
    setIndex((i) => (i - 1 + items.length) % items.length);
  }, [items.length]);

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') goNext();
      if (e.key === 'ArrowLeft') goPrev();
      if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(MAX_ZOOM, z + ZOOM_STEP));
      if (e.key === '-') setZoom((z) => Math.max(MIN_ZOOM, z - ZOOM_STEP));
      if (e.key === '0') { setZoom(1); setTranslate({ x: 0, y: 0 }); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, goNext, goPrev]);

  // Scroll to zoom
  const handleWheel = (e: React.WheelEvent): void => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z + delta)));
  };

  // Drag to pan
  const handleMouseDown = (e: React.MouseEvent): void => {
    if (zoom <= 1) return;
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, tx: translate.x, ty: translate.y };
  };

  const handleMouseMove = (e: React.MouseEvent): void => {
    if (dragRef.current === null) return;
    setTranslate({
      x: dragRef.current.tx + (e.clientX - dragRef.current.startX),
      y: dragRef.current.ty + (e.clientY - dragRef.current.startY),
    });
  };

  const handleMouseUp = (): void => { dragRef.current = null; };

  const handleDoubleClick = (): void => {
    setZoom(1);
    setTranslate({ x: 0, y: 0 });
  };

  if (item === undefined) return <></>;

  const isImage = item.mediaType === 'image';
  let displayHost = '';
  try { displayHost = new URL(item.sourceUrl).hostname; } catch { displayHost = item.sourceUrl; }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/95"
      role="dialog"
      aria-modal="true"
    >
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-3 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-white/50 text-sm tabular-nums">{index + 1} / {items.length}</span>
          {item.altText !== null && item.altText !== '' && (
            <span className="text-white/70 text-sm truncate max-w-xs">{item.altText}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {/* Zoom controls — images only */}
          {isImage && (
            <div className="flex items-center gap-1 mr-2">
              <button
                onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z - ZOOM_STEP))}
                className="flex h-8 w-8 items-center justify-center rounded-md text-white/70 hover:bg-white/10 hover:text-white transition-colors"
                aria-label="Zoom out"
              >
                <ZoomOut className="h-4 w-4" />
              </button>
              <span className="text-white/60 text-xs w-10 text-center tabular-nums">
                {Math.round(zoom * 100)}%
              </span>
              <button
                onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z + ZOOM_STEP))}
                className="flex h-8 w-8 items-center justify-center rounded-md text-white/70 hover:bg-white/10 hover:text-white transition-colors"
                aria-label="Zoom in"
              >
                <ZoomIn className="h-4 w-4" />
              </button>
              <button
                onClick={() => { setZoom(1); setTranslate({ x: 0, y: 0 }); }}
                className="flex h-8 w-8 items-center justify-center rounded-md text-white/70 hover:bg-white/10 hover:text-white transition-colors"
                aria-label="Reset zoom"
                disabled={zoom === 1}
              >
                <RotateCcw className="h-4 w-4" />
              </button>
            </div>
          )}
          <a
            href={item.mediaUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-8 w-8 items-center justify-center rounded-md text-white/70 hover:bg-white/10 hover:text-white transition-colors"
            aria-label="Open original"
          >
            <ExternalLink className="h-4 w-4" />
          </a>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md text-white/70 hover:bg-white/10 hover:text-white transition-colors"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Media area */}
      <div
        ref={containerRef}
        className={cn(
          'flex-1 flex items-center justify-center overflow-hidden relative select-none',
          isImage && zoom > 1 ? 'cursor-grab active:cursor-grabbing' : 'cursor-default',
        )}
        onWheel={isImage ? handleWheel : undefined}
        onMouseDown={isImage ? handleMouseDown : undefined}
        onMouseMove={isImage ? handleMouseMove : undefined}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onClick={(e) => {
          // Close if clicking the backdrop (not the media itself)
          if (e.target === e.currentTarget) onClose();
        }}
      >
        {isImage ? (
          imgError ? (
            <div className="flex flex-col items-center gap-3 text-white/40">
              <ImageOff className="h-16 w-16" />
              <span className="text-sm">Image unavailable</span>
            </div>
          ) : (
            <img
              src={item.mediaUrl}
              alt={item.altText ?? ''}
              draggable={false}
              onDoubleClick={handleDoubleClick}
              onError={() => setImgError(true)}
              onLoad={() => setImgLoaded(true)}
              className={cn(
                'max-h-full max-w-full object-contain transition-opacity duration-200',
                !imgLoaded && 'opacity-0',
                zoom > 1 && 'max-h-none max-w-none',
              )}
              style={{
                transform: `scale(${zoom}) translate(${translate.x / zoom}px, ${translate.y / zoom}px)`,
                transformOrigin: 'center',
                transition: dragRef.current !== null ? 'none' : 'transform 0.15s ease',
              }}
            />
          )
        ) : (
          // Video — no zoom, just centered player
          <video
            key={item.mediaUrl}
            src={item.mediaUrl}
            controls
            autoPlay
            className="max-h-full max-w-full rounded-lg shadow-2xl"
            style={{ maxHeight: 'calc(100vh - 140px)' }}
          />
        )}

        {/* Prev / Next arrows */}
        {items.length > 1 && (
          <>
            <button
              onClick={(e) => { e.stopPropagation(); goPrev(); }}
              className="absolute left-3 top-1/2 -translate-y-1/2 flex h-10 w-10 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/80 transition-colors"
              aria-label="Previous"
            >
              <ChevronLeft className="h-6 w-6" />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); goNext(); }}
              className="absolute right-3 top-1/2 -translate-y-1/2 flex h-10 w-10 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/80 transition-colors"
              aria-label="Next"
            >
              <ChevronRight className="h-6 w-6" />
            </button>
          </>
        )}
      </div>

      {/* Bottom info bar */}
      <div className="flex items-center justify-center gap-2 px-4 py-3 flex-shrink-0">
        <a
          href={item.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-xs text-white/50 hover:text-white/80 transition-colors"
        >
          <span>{displayHost}</span>
          <ExternalLink className="h-3 w-3" />
        </a>
        {isImage && (
          <span className="text-white/25 text-xs">· scroll to zoom · double-click to reset</span>
        )}
      </div>
    </div>
  );
}
