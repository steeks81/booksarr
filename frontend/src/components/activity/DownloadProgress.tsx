/**
 * DownloadProgress - Shows in-progress downloads with progress bars
 */

import React from 'react';
import type { ShelfmarkDownloadStatus } from '../../api/shelfmark';
import {
  getStatusBarColor,
  getStatusTextColor,
  getStatusProgress,
  formatDownloadProgress,
  formatStatus,
} from '../../utils/downloadUtils';
import { getSourceDisplayName } from '../../utils/formatUtils';

interface DownloadProgressProps {
  items: ShelfmarkDownloadStatus[];
  onCancel: (sourceId: string) => void;
}

export default function DownloadProgress({ items, onCancel }: DownloadProgressProps) {
  if (items.length === 0) return null;

  return (
    <div className="flex-1">
      {/* Header */}
      <div className="mb-3 flex items-center gap-2">
        <div className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
        <span className="text-xs font-medium uppercase tracking-wide text-slate-400">In Progress</span>
        <span className="rounded bg-slate-700 px-1.5 py-0.5 text-xs text-slate-400">{items.length}</span>
      </div>

      {/* Items */}
      <div className="space-y-3">
        {items.map((item) => (
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

              {/* Progress bar */}
              <div className="mt-1.5">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-700">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${getStatusBarColor(item.status)}`}
                    style={{ width: `${getStatusProgress(item.status, item.progress)}%` }}
                  />
                </div>
                {/* Status text */}
                <div className="mt-1 flex items-center justify-between text-xs">
                  <span className={getStatusTextColor(item.status)}>
                    {item.status === 'downloading' && item.progress > 0 && item.size
                      ? formatDownloadProgress(item.progress, item.size)
                      : item.status_message || formatStatus(item.status)}
                  </span>
                  {item.status === 'downloading' && item.progress > 0 && (
                    <span className="text-slate-500">{Math.round(Math.min(100, item.progress))}%</span>
                  )}
                </div>
              </div>
            </div>

            {/* Cancel button */}
            <button
              type="button"
              onClick={() => onCancel(item.source_id)}
              className="shrink-0 rounded p-1 text-slate-500 transition-colors hover:bg-slate-700 hover:text-rose-400"
              title="Cancel download"
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
