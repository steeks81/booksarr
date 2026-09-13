/**
 * ReleasesList - Display releases for a book with source tabs
 */

import React, { useState } from 'react';
import type { ShelfmarkRelease } from '../../api/shelfmark';
import ReleaseRow from './ReleaseRow';
import type { ReleaseRowStatus } from './ReleaseRow';
import { getSourceDisplayName } from '../../utils/formatUtils';

interface ReleasesListProps {
  releases: ShelfmarkRelease[];
  sources: string[];
  isLoading: boolean;
  error: string | null;
  // Status tracking for download buttons
  getDownloadStatus: (sourceId: string) => ReleaseRowStatus;
  onDownload: (release: ShelfmarkRelease) => void;
  onRetry?: (release: ShelfmarkRelease) => void;
}

export default function ReleasesList({
  releases,
  sources,
  isLoading,
  error,
  getDownloadStatus,
  onDownload,
  onRetry,
}: ReleasesListProps) {
  const [activeSource, setActiveSource] = useState<string | null>(sources[0] || null);

  // Update active source when sources change
  React.useEffect(() => {
    if (sources.length > 0 && (!activeSource || !sources.includes(activeSource))) {
      setActiveSource(sources[0]);
    }
  }, [sources, activeSource]);

  // Filter releases by active source
  const filteredReleases = React.useMemo(() => {
    if (!activeSource) return releases;
    return releases.filter((r) => r.source === activeSource);
  }, [releases, activeSource]);

  // Loading state
  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-600 border-t-emerald-500" />
        <div className="mt-4 text-sm text-slate-400">Finding releases...</div>
        <div className="mt-1 text-xs text-slate-500">This may take a while</div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4">
        <div className="text-sm text-rose-300">{error}</div>
      </div>
    );
  }

  // Empty state
  if (releases.length === 0) {
    return (
      <div className="rounded-xl border border-slate-700 bg-slate-800 p-8 text-center">
        <div className="text-sm text-slate-400">No releases found for this book.</div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800">
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
                className={`px-4 py-3 text-sm font-medium transition-colors whitespace-nowrap ${
                  activeSource === source
                    ? 'border-b-2 border-emerald-500 text-emerald-400'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {getSourceDisplayName(source)}
                <span className="ml-2 text-xs text-slate-500">({count})</span>
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
            onRetry={onRetry}
          />
        ))}
      </div>
    </div>
  );
}
