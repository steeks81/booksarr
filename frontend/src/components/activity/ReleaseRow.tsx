/**
 * ReleaseRow - Single release/download option row
 */

import React from 'react';
import type { ShelfmarkRelease } from '../../api/shelfmark';
import { getLanguageBadgeColor, getFormatBadgeColor } from '../../utils/formatUtils';

export type ReleaseRowStatus = 'idle' | 'downloading' | 'complete' | 'failed';

interface ReleaseRowProps {
  release: ShelfmarkRelease;
  status: ReleaseRowStatus;
  onDownload: (release: ShelfmarkRelease) => void;
  onRetry?: (release: ShelfmarkRelease) => void;
  onCancel?: (release: ShelfmarkRelease) => void;
}

export default function ReleaseRow({ release, status, onDownload, onRetry, onCancel }: ReleaseRowProps) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      {/* Small cover */}
      {release.cover_url ? (
        <img
          src={release.cover_url}
          alt=""
          className="h-12 w-9 shrink-0 rounded border border-slate-600 object-cover bg-slate-700"
          onError={(e) => {
            e.currentTarget.style.display = 'none';
            e.currentTarget.nextElementSibling?.classList.remove('hidden');
          }}
        />
      ) : null}
      <div
        className={`flex h-12 w-9 shrink-0 items-center justify-center rounded border border-slate-600 bg-slate-700 text-[8px] text-slate-500 ${release.cover_url ? 'hidden' : ''}`}
      >
        No cover
      </div>

      {/* Title & author */}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-slate-100">{release.title}</div>
        {release.author && <div className="truncate text-xs text-slate-400">{release.author}</div>}
      </div>

      {/* Language badge */}
      {release.language && (
        <span
          className={`shrink-0 rounded px-2 py-0.5 text-[10px] font-semibold uppercase text-white ${getLanguageBadgeColor(release.language)}`}
        >
          {release.language}
        </span>
      )}

      {/* Format badge */}
      {release.format && (
        <span
          className={`shrink-0 rounded px-2 py-0.5 text-[10px] font-semibold uppercase text-white ${getFormatBadgeColor(release.format)}`}
        >
          {release.format}
        </span>
      )}

      {/* Size */}
      <span className="w-16 shrink-0 text-right text-xs text-slate-400">{release.size || '-'}</span>

      {/* Download button / status indicator */}
      {status === 'complete' ? (
        // Green checkmark for completed
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-500">
          <svg className="h-5 w-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
          </svg>
        </div>
      ) : status === 'downloading' ? (
        // Spinner for downloading - shows X on hover to cancel
        <button
          type="button"
          onClick={() => onCancel?.(release)}
          className="group relative flex h-8 w-8 shrink-0 items-center justify-center"
          title="Downloading... (click to cancel)"
        >
          {/* Spinner - visible by default, hidden on hover */}
          <svg className="h-6 w-6 animate-spin text-slate-400 group-hover:hidden" fill="none" viewBox="0 0 24 24">
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="3"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          {/* X icon - hidden by default, visible on hover */}
          <svg className="hidden h-5 w-5 text-rose-400 group-hover:block" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      ) : status === 'failed' ? (
        // Red X with retry option
        <button
          type="button"
          onClick={() => onRetry?.(release)}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-500 hover:bg-red-600 transition-colors"
          title="Retry download"
        >
          <svg className="h-5 w-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
        </button>
      ) : (
        // Download arrow button
        <button
          type="button"
          onClick={() => onDownload(release)}
          className="shrink-0 rounded p-1.5 text-slate-400 transition-colors hover:bg-slate-700 hover:text-emerald-400"
          title="Download"
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
            />
          </svg>
        </button>
      )}
    </div>
  );
}
