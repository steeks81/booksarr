/**
 * ReleaseGroup - Collapsible book group with releases
 * Used in ActivityPage's Releases panel
 */

import React, { useState } from 'react';
import type { ShelfmarkRelease, BookSearchEntry } from '../../api/shelfmark';
import ReleaseRow from './ReleaseRow';
import type { ReleaseRowStatus } from './ReleaseRow';
import { getSourceDisplayName } from '../../utils/formatUtils';

interface ReleaseGroupProps {
  entry: BookSearchEntry;
  getDownloadStatus: (sourceId: string) => ReleaseRowStatus;
  onDownload: (release: ShelfmarkRelease) => void;
  onRetryDownload?: (release: ShelfmarkRelease) => void;
  onCancelDownload?: (release: ShelfmarkRelease) => void;
  onRemove: () => void;
  onRetryFetch: () => void;
  onInfoClick: () => void;
  isOwned?: boolean;
  isInCatalog?: boolean;
}

export default function ReleaseGroup({
  entry,
  getDownloadStatus,
  onDownload,
  onRetryDownload,
  onCancelDownload,
  onRemove,
  onRetryFetch,
  onInfoClick,
  isOwned,
  isInCatalog,
}: ReleaseGroupProps) {
  const [expanded, setExpanded] = useState(true);
  const [activeSource, setActiveSource] = useState<string | null>(null);

  // Get releases (handle null from backend)
  const releases = entry.releases || [];

  // Get unique sources
  const sources = React.useMemo(() => {
    const seen = new Set<string>();
    releases.forEach((r) => {
      if (r.source) seen.add(r.source);
    });
    return Array.from(seen);
  }, [releases]);

  // Set initial active source
  React.useEffect(() => {
    if (sources.length > 0 && !activeSource) {
      setActiveSource(sources[0]);
    }
  }, [sources, activeSource]);

  // Filter releases by active source
  const filteredReleases = React.useMemo(() => {
    if (!activeSource) return releases;
    return releases.filter((r) => r.source === activeSource);
  }, [releases, activeSource]);

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800 overflow-hidden">
      {/* Header */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-slate-700/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {/* Expand/collapse chevron */}
        <svg
          className={`h-4 w-4 text-slate-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>

        {/* Cover thumbnail */}
        {entry.book.cover_url ? (
          <img
            src={entry.book.cover_url}
            alt=""
            className="h-10 w-7 shrink-0 rounded border border-slate-600 object-cover bg-slate-700"
            title={isOwned ? "Owned" : isInCatalog ? "In catalog (watching)" : undefined}
          />
        ) : (
          <div 
            className="flex h-10 w-7 shrink-0 items-center justify-center rounded border border-slate-600 bg-slate-700 text-[8px] text-slate-500"
            title={isOwned ? "Owned" : isInCatalog ? "In catalog (watching)" : undefined}
          >
            No cover
          </div>
        )}

        {/* Title and author */}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-slate-100">{entry.book.title}</div>
          {entry.book.author && (
            <div className="truncate text-xs text-slate-400">{entry.book.author}</div>
          )}
        </div>

        {/* Status indicator */}
        {entry.status === 'pending' && (
          <span className="text-xs text-slate-500">Pending</span>
        )}
        {entry.status === 'fetching' && (
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-600 border-t-emerald-500" />
        )}
        {entry.status === 'complete' && releases.length > 0 && (
          <span className="text-xs text-slate-500">{releases.length} releases</span>
        )}
        {entry.status === 'error' && (
          <span className="text-xs text-red-400">Error</span>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {/* Retry button (only for complete/error) */}
          {(entry.status === 'complete' || entry.status === 'error') && (
            <button
              type="button"
              onClick={onRetryFetch}
              className="rounded p-1.5 text-slate-400 hover:bg-slate-700 hover:text-emerald-400 transition-colors"
              title="Retry search"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          )}
          {/* Info button */}
          <button
            type="button"
            onClick={onInfoClick}
            className="rounded p-1.5 text-slate-400 hover:bg-slate-700 hover:text-slate-200 transition-colors"
            title="View details"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M12 20a8 8 0 100-16 8 8 0 000 16z" />
            </svg>
          </button>
          {/* Remove button */}
          <button
            type="button"
            onClick={onRemove}
            className="rounded p-1.5 text-slate-400 hover:bg-slate-700 hover:text-rose-400 transition-colors"
            title="Remove"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-slate-700">
          {/* Loading state */}
          {entry.status === 'fetching' && (
            <div className="flex items-center justify-center py-8">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-600 border-t-emerald-500" />
              <span className="ml-3 text-sm text-slate-400">Finding releases...</span>
            </div>
          )}

          {/* Error state */}
          {entry.status === 'error' && (
            <div className="p-4">
              <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">
                {entry.error || 'Failed to fetch releases'}
              </div>
              <button
                type="button"
                onClick={onRetryFetch}
                className="mt-2 text-xs text-slate-400 hover:text-slate-200"
              >
                Retry
              </button>
            </div>
          )}

          {/* Empty state */}
          {entry.status === 'complete' && releases.length === 0 && (
            <div className="p-4 text-center">
              <div className="text-sm text-slate-500">No releases found</div>
            </div>
          )}

          {/* Releases */}
          {entry.status === 'complete' && releases.length > 0 && (
            <>
              {/* Source tabs */}
              {sources.length > 1 && (
                <div className="flex border-b border-slate-700 overflow-x-auto">
                  {sources.map((source) => {
                    const count = releases.filter((r) => r.source === source).length;
                    return (
                      <button
                        key={source}
                        type="button"
                        onClick={() => setActiveSource(source)}
                        className={`px-3 py-2 text-xs font-medium transition-colors whitespace-nowrap ${
                          activeSource === source
                            ? 'border-b-2 border-emerald-500 text-emerald-400'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {getSourceDisplayName(source)}
                        <span className="ml-1 text-slate-500">({count})</span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Release rows */}
              <div className="divide-y divide-slate-700">
                {filteredReleases.map((release, index) => (
                  <ReleaseRow
                    key={`${release.source}-${release.source_id}-${index}`}
                    release={release}
                    status={getDownloadStatus(release.source_id)}
                    onDownload={onDownload}
                    onRetry={onRetryDownload}
                    onCancel={onCancelDownload}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
