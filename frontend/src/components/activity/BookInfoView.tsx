/**
 * BookInfoView - Detailed book information display
 * Shows cover, metadata, description, series info
 */

import React from 'react';
import type { ShelfmarkSearchResult } from '../../api/shelfmark';
import type { ProviderMatchEntry } from '../../api/books';
import { stripHtml } from '../../utils/searchUtils';

// Format badge styles
const FORMAT_BADGE_STYLES: Record<string, { label: string; className: string }> = {
  epub: { label: 'EPUB', className: 'bg-emerald-600 text-white' },
  pdf: { label: 'PDF', className: 'bg-rose-600 text-white' },
  mobi: { label: 'MOBI', className: 'bg-amber-600 text-white' },
  audio: { label: 'AUDIO', className: 'bg-purple-600 text-white' },
};

interface BookInfoViewProps {
  book: ShelfmarkSearchResult;
  matchedBook: ProviderMatchEntry | null;
  onBackClick: () => void;
  onSeriesClick?: (seriesName: string, author: string | null, seriesId: string | null) => void;
  onFindReleasesClick?: () => void;
  showFindReleasesButton?: boolean;
  isQueued?: boolean;
}

export default function BookInfoView({
  book,
  matchedBook,
  onBackClick,
  onSeriesClick,
  onFindReleasesClick,
  showFindReleasesButton = true,
  isQueued = false,
}: BookInfoViewProps) {
  // Compute display values with fallbacks
  const displayYear =
    book.year || (matchedBook?.release_date ? new Date(matchedBook.release_date).getFullYear() : null);

  const ratingField = book.display_fields?.find((f) => f.icon === 'star');
  const readersField = book.display_fields?.find((f) => f.icon === 'users');

  const displaySeriesName = book.series_name || matchedBook?.series_name;
  const displaySeriesPosition = book.series_position ?? matchedBook?.series_position;
  const displaySeriesCount = book.series_count ?? matchedBook?.series_count;

  const displayIsbn = book.isbn || matchedBook?.isbn;
  const displayDescription = book.description || matchedBook?.description;

  // Cover URL - prefer our cached cover if matched
  let coverUrl: string | null = null;
  if (matchedBook?.cover_path) {
    // Extract filename from path like "cache/books/abs_2039.jpg" -> "abs_2039.jpg"
    const filename = matchedBook.cover_path.split('/').pop();
    if (filename) {
      coverUrl = `/api/images/books/${filename}`;
    }
  } else if (book.cover_url) {
    coverUrl = book.cover_url;
    // Shelfmark cover URL contains base64-encoded original URL in ?url= param
    // Decode and use directly to avoid auth issues
    if (coverUrl.includes('/api/covers/')) {
      try {
        const urlParam = new URL(coverUrl).searchParams.get('url');
        if (urlParam) {
          coverUrl = atob(urlParam.replace(/-/g, '+').replace(/_/g, '/'));
        }
      } catch {
        // Failed to decode, keep original
      }
    }
  }

  const isOwned = matchedBook?.is_owned ?? false;
  const isInCatalogMissing = matchedBook != null && !matchedBook.is_owned;
  const ownedFormats = new Set(matchedBook?.formats || []);

  return (
    <div className="flex flex-col h-full">
      {/* Back button */}
      <button
        type="button"
        onClick={onBackClick}
        className="mb-4 flex items-center gap-1 text-sm text-slate-400 hover:text-slate-200 self-start"
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Back to search results
      </button>

      {/* Book info content */}
      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col gap-6 lg:flex-row lg:gap-8">
          {/* Cover - larger sizing like SM, with owned/watching badge overlay */}
          <div className="relative flex justify-center lg:justify-start lg:self-start shrink-0">
            {coverUrl ? (
              <img
                src={coverUrl}
                alt=""
                className="max-h-[60vh] w-auto max-w-[432px] rounded-xl border border-slate-600 object-contain bg-slate-800 shadow-lg"
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                  e.currentTarget.nextElementSibling?.classList.remove('hidden');
                }}
              />
            ) : null}
            <div
              className={`flex h-64 w-44 items-center justify-center rounded-xl border border-dashed border-slate-600 bg-slate-800/60 text-sm text-slate-500 ${coverUrl ? 'hidden' : ''}`}
            >
              No cover
            </div>
            {/* Owned badge - top right of cover */}
            {isOwned && (
              <div className="absolute top-2 right-2 rounded-full bg-emerald-500 p-1.5" title="Owned">
                <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 20 20">
                  <path
                    fillRule="evenodd"
                    d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 111.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                    clipRule="evenodd"
                  />
                </svg>
              </div>
            )}
            {/* Watching badge - top right of cover (in catalog but not owned) */}
            {isInCatalogMissing && (
              <div
                className="absolute top-2 right-2 rounded-full bg-amber-500 p-1.5"
                title="In catalog (watching)"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="white">
                  <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" />
                </svg>
              </div>
            )}
            {/* Queued indicator - bottom right of cover */}
            {isQueued && (
              <div
                className="absolute bottom-2 right-2 rounded-full bg-blue-500 p-1.5"
                title="In releases queue"
              >
                <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" />
                </svg>
              </div>
            )}
          </div>

          {/* Metadata - compact layout */}
          <div className="flex-1 space-y-3">
            {/* Top row: Year, Rating, Readers */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-300">
              {displayYear && <span>{displayYear}</span>}
              {ratingField && (
                <span className="flex items-center gap-1">
                  <span className="text-amber-400">★</span>
                  <span>{ratingField.value}</span>
                  {ratingField.label && <span className="text-slate-500">{ratingField.label}</span>}
                </span>
              )}
              {readersField && (
                <span className="flex items-center gap-1">
                  <svg
                    className="h-4 w-4 text-slate-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    strokeWidth={1.5}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z"
                    />
                  </svg>
                  <span>{readersField.value}</span>
                  <span className="text-slate-500">{readersField.label}</span>
                </span>
              )}
            </div>

            {/* Format badges - show all 4, highlight owned */}
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(FORMAT_BADGE_STYLES).map(([key, style]) => {
                const owned = ownedFormats.has(key);
                return (
                  <span
                    key={key}
                    className={`rounded px-2 py-0.5 text-xs font-medium ${
                      owned ? style.className : 'bg-slate-700/50 text-slate-500'
                    }`}
                  >
                    {style.label}
                  </span>
                );
              })}
            </div>

            {/* Series line */}
            {displaySeriesName && (
              <button
                type="button"
                onClick={() => onSeriesClick?.(displaySeriesName, book.author, book.series_id)}
                className="text-sm font-medium text-emerald-400 hover:text-emerald-300 hover:underline text-left"
              >
                {displaySeriesPosition != null ? (
                  <>
                    #{displaySeriesPosition}
                    {displaySeriesCount ? ` of ${displaySeriesCount}` : ''} in {displaySeriesName}
                  </>
                ) : (
                  displaySeriesName
                )}
              </button>
            )}

            {/* Description */}
            {displayDescription && (
              <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4 max-h-[480px] overflow-y-auto">
                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                  Description
                </div>
                <div className="text-sm text-slate-300 leading-relaxed whitespace-pre-line">
                  {stripHtml(displayDescription)}
                </div>
              </div>
            )}

            {/* Bottom row: ISBN and View on source */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              {displayIsbn && (
                <span className="text-slate-400">
                  ISBN: <span className="font-mono text-slate-300">{displayIsbn}</span>
                </span>
              )}
              {book.source_url && (
                <a
                  href={book.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-emerald-400 hover:text-emerald-300 transition-colors"
                >
                  View on{' '}
                  {(() => {
                    const src = (book.source || '').toLowerCase();
                    if (src.includes('hardcover')) return 'Hardcover';
                    if (src.includes('google')) return 'Google Books';
                    if (src.includes('openlibrary') || src.includes('open library'))
                      return 'Open Library';
                    return 'Source';
                  })()}
                </a>
              )}
            </div>

            {/* Find releases button */}
            {showFindReleasesButton && onFindReleasesClick && (
              <button
                type="button"
                onClick={onFindReleasesClick}
                className="mt-4 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 transition-colors"
              >
                Find Releases
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
