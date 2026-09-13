/**
 * DownloadFinished - Shows completed and failed downloads
 */

import React from 'react';
import type { ShelfmarkDownloadStatus } from '../../api/shelfmark';
import { getSourceDisplayName } from '../../utils/formatUtils';

interface DownloadFinishedProps {
  failed: ShelfmarkDownloadStatus[];
  complete: ShelfmarkDownloadStatus[];
  onRetry: (sourceId: string) => void;
  onDismiss: (sourceId: string) => void;
  onClearAll: () => void;
}

export default function DownloadFinished({
  failed,
  complete,
  onRetry,
  onDismiss,
  onClearAll,
}: DownloadFinishedProps) {
  const hasItems = failed.length > 0 || complete.length > 0;
  if (!hasItems) return null;

  return (
    <div className="flex-1">
      {/* Header */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-400">Finished</span>
          {failed.length > 0 && (
            <span className="rounded bg-red-500/20 px-1.5 py-0.5 text-xs text-red-400">
              Failed {failed.length}
            </span>
          )}
          {complete.length > 0 && (
            <span className="rounded bg-green-500/20 px-1.5 py-0.5 text-xs text-green-400">
              Complete {complete.length}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClearAll}
          className="text-xs text-slate-400 transition-colors hover:text-slate-200"
        >
          Clear All
        </button>
      </div>

      {/* Items */}
      <div className="space-y-3">
        {/* Failed items first */}
        {failed.map((item) => (
          <div key={item.source_id} className="flex items-center gap-3">
            {/* Cover */}
            {item.cover_url ? (
              <img
                src={item.cover_url}
                alt=""
                className="h-12 w-9 shrink-0 rounded border border-slate-600 object-cover bg-slate-700"
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                  e.currentTarget.nextElementSibling?.classList.remove('hidden');
                }}
              />
            ) : null}
            <div
              className={`flex h-12 w-9 shrink-0 items-center justify-center rounded border border-slate-600 bg-slate-700 text-[8px] text-slate-500 ${item.cover_url ? 'hidden' : ''}`}
            >
              No Cover
            </div>

            {/* Info */}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-slate-100">{item.title}</span>
                {item.author && (
                  <span className="truncate text-sm text-slate-500">— {item.author}</span>
                )}
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-400">
                <span>{item.source_display_name || getSourceDisplayName(item.source)}</span>
                {item.format && (
                  <>
                    <span>·</span>
                    <span className="uppercase">{item.format}</span>
                  </>
                )}
                {item.size && (
                  <>
                    <span>·</span>
                    <span>{item.size}</span>
                  </>
                )}
              </div>
              <div className="mt-1 text-xs text-red-400">
                {item.status === 'cancelled' ? 'Cancelled' : item.status_message || 'Error'}
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex shrink-0 items-center">
              {/* Retry button */}
              <button
                type="button"
                onClick={() => onRetry(item.source_id)}
                className="rounded p-1 text-slate-500 transition-colors hover:bg-slate-700 hover:text-slate-300"
                title="Retry download"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                  />
                </svg>
              </button>
              {/* Dismiss button */}
              <button
                type="button"
                onClick={() => onDismiss(item.source_id)}
                className="rounded p-1 text-slate-500 transition-colors hover:bg-slate-700 hover:text-rose-400"
                title="Dismiss"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        ))}

        {/* Complete items */}
        {complete.map((item) => (
          <div key={item.source_id} className="flex items-center gap-3">
            {/* Cover */}
            {item.cover_url ? (
              <img
                src={item.cover_url}
                alt=""
                className="h-12 w-9 shrink-0 rounded border border-slate-600 object-cover bg-slate-700"
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                  e.currentTarget.nextElementSibling?.classList.remove('hidden');
                }}
              />
            ) : null}
            <div
              className={`flex h-12 w-9 shrink-0 items-center justify-center rounded border border-slate-600 bg-slate-700 text-[8px] text-slate-500 ${item.cover_url ? 'hidden' : ''}`}
            >
              No Cover
            </div>

            {/* Info */}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-slate-100">{item.title}</span>
                {item.author && (
                  <span className="truncate text-sm text-slate-500">— {item.author}</span>
                )}
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-400">
                <span>{item.source_display_name || getSourceDisplayName(item.source)}</span>
                {item.format && (
                  <>
                    <span>·</span>
                    <span className="uppercase">{item.format}</span>
                  </>
                )}
                {item.size && (
                  <>
                    <span>·</span>
                    <span>{item.size}</span>
                  </>
                )}
              </div>
              <div className="mt-1 text-xs text-green-400">Complete</div>
            </div>

            {/* Dismiss button only for complete */}
            <button
              type="button"
              onClick={() => onDismiss(item.source_id)}
              className="shrink-0 rounded p-1 text-slate-500 transition-colors hover:bg-slate-700 hover:text-slate-300"
              title="Dismiss"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
