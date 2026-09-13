/**
 * SearchResultRow - Single search result row
 * Memoized to prevent re-renders when other rows change
 */

import React from 'react';
import type { ShelfmarkSearchResult } from '../../api/shelfmark';
import type { SeriesInfo } from '../../types/activity';
import { queueImagePreload, isImagePreloaded } from '../../utils/imagePreloader';

export interface EnrichedData {
  series_name: string | null;
  series_position: number | null;
  series_count: number | null;
  isbn: string | null;
  enriched_at: number;
}

export interface DbSeriesData {
  series_name: string | null;
  series_position: number | null;
  series_count: number | null;
}

export interface SearchResultRowProps {
  result: ShelfmarkSearchResult;
  index: number;
  coverUrl: string | null; // Pre-computed: getOwnedCover(result) || result.cover_url
  isOwned: boolean;
  isInCatalogMissing: boolean;
  isEnriched: boolean;
  enrichedData?: EnrichedData | null;
  dbIsbn?: string | null; // ISBN from our local DB (via provider-match)
  dbSeriesData?: DbSeriesData | null; // Series from our DB
  isQueued?: boolean; // True if already in releases queue
  onVisible?: (result: ShelfmarkSearchResult) => void; // Called when row becomes visible
  onResultClick: (result: ShelfmarkSearchResult) => void;
  onQueueClick: (result: ShelfmarkSearchResult) => void; // Called when + button clicked
  onTitleClick: (title: string, author: string | null, seriesName: string | null) => void;
  onAuthorClick: (author: string, title: string, seriesName: string | null) => void;
  onSeriesClick: (seriesName: string, author: string | null, seriesId: string | null) => void;
  onInfoClick: (result: ShelfmarkSearchResult) => void;
}

// Memoized row component to prevent re-renders when other rows change
// Custom comparison: only re-render if data props change (ignore function props)
const SearchResultRow = React.memo(
  function SearchResultRow({
    result,
    index,
    coverUrl,
    isOwned,
    isInCatalogMissing,
    isEnriched,
    enrichedData,
    dbIsbn,
    dbSeriesData,
    isQueued,
    onVisible,
    onResultClick,
    onQueueClick,
    onTitleClick,
    onAuthorClick,
    onSeriesClick,
    onInfoClick,
  }: SearchResultRowProps) {
    const rowRef = React.useRef<HTMLDivElement>(null);
    const [imageReady, setImageReady] = React.useState(() =>
      coverUrl ? isImagePreloaded(coverUrl) : false
    );

    // IntersectionObserver to detect when row becomes visible
    React.useEffect(() => {
      if (!onVisible || !rowRef.current) return;

      const observer = new IntersectionObserver(
        (entries) => {
          if (entries[0]?.isIntersecting) {
            onVisible(result);
            observer.disconnect(); // Only trigger once per row
          }
        },
        { threshold: 0.1 } // Trigger when 10% visible
      );

      observer.observe(rowRef.current);
      return () => observer.disconnect();
    }, [onVisible, result]);

    // Queue image preload when row mounts - callback sets imageReady when done
    React.useEffect(() => {
      if (!coverUrl) return;
      if (isImagePreloaded(coverUrl)) {
        setImageReady(true);
        return;
      }
      // Priority for first 20 rows
      queueImagePreload(coverUrl, index < 20, () => setImageReady(true));
    }, [coverUrl, index]);

    return (
      <div
        ref={rowRef}
        id={`result-row-${result.id}`}
        data-result-id={result.id}
        className={`flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-slate-800/60 ${index > 0 ? 'border-t border-slate-700' : ''}`}
      >
        {/* Cover with position badge above (like SeriesGroup) and owned tick inside */}
        <div className="relative shrink-0">
          {/* Series position badge - above image (like SeriesGroup) */}
          {result.series_position != null && (
            <div className="absolute -top-2 -left-1.5 z-10 flex h-4 min-w-4 items-center justify-center rounded-full bg-slate-700 border border-slate-600 px-1 text-[9px] font-bold text-slate-300">
              {result.series_position}
            </div>
          )}
          <button type="button" onClick={() => onResultClick(result)} className="relative">
            {coverUrl && imageReady ? (
              <img
                src={coverUrl}
                alt=""
                className="h-16 w-12 rounded border border-slate-600 object-cover bg-slate-800"
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                  e.currentTarget.nextElementSibling?.classList.remove('hidden');
                }}
              />
            ) : null}
            <div
              className={`flex h-16 w-12 items-center justify-center rounded border border-slate-600 bg-slate-800 text-[10px] text-slate-500 ${coverUrl && imageReady ? 'hidden' : ''}`}
            >
              {coverUrl && !imageReady ? '...' : 'No cover'}
            </div>
            {/* Owned checkmark - inside image top right (like BookCard) */}
            {isOwned && (
              <div
                className="absolute top-0.5 right-0.5 rounded-full bg-emerald-500 p-0.5"
                title="Owned"
              >
                <svg className="w-2.5 h-2.5 text-white" fill="currentColor" viewBox="0 0 20 20">
                  <path
                    fillRule="evenodd"
                    d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 111.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                    clipRule="evenodd"
                  />
                </svg>
              </div>
            )}
            {/* In catalog but missing - amber circle with white eye */}
            {isInCatalogMissing && (
              <div
                className="absolute top-0.5 right-0.5 rounded-full bg-amber-500 p-0.5"
                title="In catalog (watching)"
              >
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="white">
                  <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" />
                </svg>
              </div>
            )}
            {/* Queued indicator - bottom right */}
            {isQueued && (
              <div
                className="absolute bottom-0.5 right-0.5 rounded-full bg-blue-500 p-0.5"
                title="In releases queue"
              >
                <svg className="w-2.5 h-2.5 text-white" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" />
                </svg>
              </div>
            )}
          </button>
        </div>

        {/* Main content - clickable to go to releases */}
        <button type="button" onClick={() => onResultClick(result)} className="min-w-0 flex-1 text-left">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onTitleClick(result.title, result.author, result.series_name);
            }}
            className="truncate text-sm font-medium text-slate-100 hover:text-emerald-300 hover:underline text-left"
          >
            {result.title}
            {/* Debug indicators: Green E = enriched with series, Blue E = enriched (ISBN only), Amber E = already had series, Cyan E = has DB ISBN, Gray E = no series hint */}
            {isEnriched && enrichedData ? (
              (() => {
                const hasSeries =
                  enrichedData.series_position != null || enrichedData.series_name;
                const hasIsbnOnly = !hasSeries && enrichedData.isbn;
                const isRecent = Date.now() - enrichedData.enriched_at < 30000; // 30 seconds
                const colorClass = hasSeries
                  ? isRecent
                    ? 'text-emerald-400'
                    : 'text-emerald-600'
                  : hasIsbnOnly
                    ? isRecent
                      ? 'text-blue-400'
                      : 'text-blue-600'
                    : 'text-slate-400';
                const label = hasSeries ? 'series' : hasIsbnOnly ? 'ISBN only' : 'no data';
                const timeAgo = Math.round((Date.now() - enrichedData.enriched_at) / 1000);
                return (
                  <span
                    className={`ml-2 px-1 ${colorClass} text-xs font-bold cursor-help hover:bg-slate-700 rounded`}
                    title={`Enriched (${label}) ${timeAgo}s ago: ${
                      [
                        enrichedData.series_name
                          ? `series="${enrichedData.series_name}"`
                          : null,
                        enrichedData.series_position != null
                          ? `pos=${enrichedData.series_position}`
                          : null,
                        enrichedData.series_count ? `count=${enrichedData.series_count}` : null,
                        enrichedData.isbn ? `isbn=${enrichedData.isbn}` : null,
                      ]
                        .filter(Boolean)
                        .join(', ') || 'no data'
                    }`}
                  >
                    E
                  </span>
                );
              })()
            ) : result.series_position !== null ? (
              <span
                className="ml-2 px-1 text-amber-400 text-xs font-bold cursor-help hover:bg-slate-700 rounded"
                title="Already has series_position from search"
              >
                E
              </span>
            ) : dbIsbn ? (
              <span
                className="ml-2 px-1 text-cyan-400 text-xs font-bold cursor-help hover:bg-slate-700 rounded"
                title={`Has ISBN from DB: ${dbIsbn}`}
              >
                E
              </span>
            ) : !result.series_name ? (
              <span
                className="ml-2 px-1 text-slate-500 text-xs font-bold cursor-help hover:bg-slate-700 rounded"
                title="No series hint - ISBN fetched on-demand"
              >
                E
              </span>
            ) : null}
          </button>
          {(result.author ||
            result.series_name ||
            enrichedData?.series_name ||
            dbSeriesData?.series_name) && (
            <div className="mt-0.5 truncate text-xs text-slate-400">
              {result.author && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onAuthorClick(
                      result.author!,
                      result.title,
                      result.series_name || enrichedData?.series_name || dbSeriesData?.series_name || null
                    );
                  }}
                  className="hover:text-emerald-300 hover:underline"
                >
                  {result.author}
                </button>
              )}
              {result.author &&
                (result.series_name || enrichedData?.series_name || dbSeriesData?.series_name) &&
                ' · '}
              {(result.series_name || enrichedData?.series_name || dbSeriesData?.series_name) && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    const seriesName =
                      result.series_name || enrichedData?.series_name || dbSeriesData?.series_name;
                    onSeriesClick(seriesName!, result.author, result.series_id);
                  }}
                  className="text-emerald-400 hover:text-emerald-300 hover:underline"
                >
                  {(() => {
                    // Prefer result data, then enriched data, then DB data
                    const seriesPos =
                      result.series_position ??
                      enrichedData?.series_position ??
                      dbSeriesData?.series_position;
                    const seriesCount =
                      result.series_count ??
                      enrichedData?.series_count ??
                      dbSeriesData?.series_count;
                    const seriesName =
                      result.series_name ?? enrichedData?.series_name ?? dbSeriesData?.series_name;
                    if (seriesPos != null) {
                      return `#${seriesPos}${seriesCount ? ` of ${seriesCount}` : ''} in ${seriesName}`;
                    }
                    return seriesName;
                  })()}
                </button>
              )}
            </div>
          )}
          {/* Year and rating row */}
          <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs text-slate-500">
            {result.year && <span>{result.year}</span>}
            {(result.isbn || dbIsbn) && (
              <span className="font-mono text-slate-400">ISBN: {result.isbn || dbIsbn}</span>
            )}
            {result.display_fields?.map((field, idx) => (
              <span key={idx} className="flex items-center gap-0.5">
                {field.icon === 'star' && <span className="text-amber-400">★</span>}
                {field.icon === 'users' && <span>👥</span>}
                <span>{field.value}</span>
                {field.label && <span className="text-slate-600">({field.label})</span>}
              </span>
            ))}
            {result.source && !result.year && !result.display_fields?.length && (
              <span>{result.source}</span>
            )}
          </div>
        </button>

        {/* Action buttons */}
        <div className="flex shrink-0 items-center gap-1 self-center">
          {/* Info button */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onInfoClick(result);
            }}
            className="rounded p-1.5 text-slate-400 hover:bg-slate-700 hover:text-slate-200 transition-colors"
            title="View details"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M13 16h-1v-4h-1m1-4h.01M12 20a8 8 0 100-16 8 8 0 000 16z"
              />
            </svg>
          </button>
          {/* Arrow indicator - clickable to queue for releases */}
          <button
            type="button"
            onClick={() => onQueueClick(result)}
            className="rounded p-1.5 text-slate-400 hover:bg-slate-700 hover:text-emerald-400 transition-colors"
            title="Find releases"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
          </button>
        </div>
      </div>
    );
  },
  (prevProps, nextProps) => {
    // Custom comparison: only re-render if data/state props change
    // Ignore function props since they're stable in behavior even if reference changes
    return (
      prevProps.result.id === nextProps.result.id &&
      prevProps.result.provider === nextProps.result.provider &&
      prevProps.result.series_position === nextProps.result.series_position &&
      prevProps.coverUrl === nextProps.coverUrl &&
      prevProps.index === nextProps.index &&
      prevProps.isOwned === nextProps.isOwned &&
      prevProps.isInCatalogMissing === nextProps.isInCatalogMissing &&
      prevProps.isEnriched === nextProps.isEnriched &&
      prevProps.isQueued === nextProps.isQueued
    );
  }
);

export default SearchResultRow;
