/**
 * SearchResultsList - Displays search results with filtering
 */

import React from 'react';
import type { ShelfmarkSearchResult } from '../../api/shelfmark';
import type { ProviderMatchEntry } from '../../api/books';
import SearchResultRow from './SearchResultRow';
import type { EnrichedData, DbSeriesData } from './SearchResultRow';
import type { OwnershipFilter } from '../../types/activity';

interface SearchResultsListProps {
  results: ShelfmarkSearchResult[];
  totalResults: number;
  filterText: string;
  isSearching: boolean;
  hasSearched: boolean;
  searchError: string | null;
  // Provider match data for ownership/series info
  providerMatchByHcId?: Record<string, ProviderMatchEntry>;
  providerMatchByGoogleId?: Record<string, ProviderMatchEntry>;
  providerMatchByIsbn?: Record<string, ProviderMatchEntry>;
  // Enrichment data
  enrichedBooks?: Map<string, EnrichedData>;
  // Enrichment progress for caching indicator
  enrichmentStatus?: {
    done: number;
    total: number;
    isRunning: boolean;
    error?: string | null;
  };
  // Scroll restoration
  scrollToResultId?: string | null;
  scrollToResultOffset?: number; // Pixel offset from container top for precise restoration
  // Handlers
  onFilterChange: (text: string) => void;
  onResultClick: (result: ShelfmarkSearchResult) => void;
  onQueueClick: (result: ShelfmarkSearchResult) => void;
  onInfoClick: (result: ShelfmarkSearchResult) => void;
  onTitleClick: (title: string, author: string | null, seriesName: string | null) => void;
  onAuthorClick: (author: string, title: string, seriesName: string | null) => void;
  onSeriesClick: (seriesName: string, author: string | null, seriesId: string | null) => void;
  onVisible?: (result: ShelfmarkSearchResult) => void;
  // Options
  ownershipFilter?: OwnershipFilter;
  onOwnershipFilterChange?: (filter: OwnershipFilter) => void;
  // Sort
  sortBy?: 'relevance' | 'series' | 'title' | 'year';
  onSortChange?: (sort: 'relevance' | 'series' | 'title' | 'year') => void;
  // Queue indicator
  queuedKeys?: Set<string>;
}

export default function SearchResultsList({
  results,
  totalResults,
  filterText,
  isSearching,
  hasSearched,
  searchError,
  providerMatchByHcId = {},
  providerMatchByGoogleId = {},
  providerMatchByIsbn = {},
  enrichedBooks,
  enrichmentStatus,
  scrollToResultId,
  scrollToResultOffset = 0,
  onFilterChange,
  onResultClick,
  onQueueClick,
  onInfoClick,
  onTitleClick,
  onAuthorClick,
  onSeriesClick,
  onVisible,
  ownershipFilter = 'all',
  onOwnershipFilterChange,
  sortBy = 'relevance',
  onSortChange,
  queuedKeys,
}: SearchResultsListProps) {
  const scrollContainerRef = React.useRef<HTMLDivElement>(null);

  // Helper to get matched book from provider match data
  const getMatchedBook = React.useCallback(
    (result: ShelfmarkSearchResult): ProviderMatchEntry | null => {
      // Try HC ID first
      if (result.provider === 'hardcover' && result.id) {
        const match = providerMatchByHcId[result.id];
        if (match) return match;
      }
      // Try Google ID
      if (result.provider === 'googlebooks' && result.id) {
        const match = providerMatchByGoogleId[result.id];
        if (match) return match;
      }
      // Fall back to ISBN
      if (result.isbn) {
        const normalized = result.isbn.replace(/[-\s]/g, '').toLowerCase();
        const match = providerMatchByIsbn[normalized];
        if (match) return match;
      }
      return null;
    },
    [providerMatchByHcId, providerMatchByGoogleId, providerMatchByIsbn]
  );

  // Filter and sort results
  const filteredResults = React.useMemo(() => {
    let filtered = results;

    // Filter by text
    if (filterText.trim()) {
      const lower = filterText.toLowerCase();
      filtered = filtered.filter(
        (r) =>
          r.title?.toLowerCase().includes(lower) ||
          r.author?.toLowerCase().includes(lower) ||
          r.series_name?.toLowerCase().includes(lower)
      );
    }

    // Filter based on ownership filter
    if (ownershipFilter !== 'all') {
      filtered = filtered.filter((r) => {
        const matched = getMatchedBook(r);
        if (!matched) return false; // Not in DB - only show in "all"
        if (ownershipFilter === 'missing') return !matched.is_owned;
        if (ownershipFilter === 'owned') return matched.is_owned;
        return true;
      });
    }

    // Sort
    if (sortBy !== 'relevance') {
      filtered = [...filtered].sort((a, b) => {
        switch (sortBy) {
          case 'series':
            // Empty series sorts last (use high Unicode char)
            const seriesA = a.series_name?.trim() || '\uffff';
            const seriesB = b.series_name?.trim() || '\uffff';
            if (seriesA !== seriesB) return seriesA.localeCompare(seriesB);
            // Secondary sort by series position
            return (a.series_position ?? 999) - (b.series_position ?? 999);
          case 'title':
            return (a.title || '').toLowerCase().localeCompare((b.title || '').toLowerCase());
          case 'year':
            return (b.year || 0) - (a.year || 0); // Descending
          default:
            return 0;
        }
      });
    }

    return filtered;
  }, [results, filterText, ownershipFilter, getMatchedBook, sortBy]);

  // Scroll to top when new results arrive (no scroll restoration requested)
  React.useEffect(() => {
    // If scrollToResultId is set, scroll restoration effect will handle positioning
    if (scrollToResultId) return;
    
    // Reset scroll to top for new results
    if (scrollContainerRef.current && results.length > 0) {
      scrollContainerRef.current.scrollTop = 0;
    }
  }, [results, scrollToResultId]);

  // Scroll restoration: scroll to target row when scrollToResultId/Offset change
  React.useEffect(() => {
    if (!scrollToResultId || !scrollContainerRef.current) return;
    
    const start = Date.now();
    const maxWait = 1000;
    let lastScrollTarget = -1;
    let lastHeight = 0;
    let stableCount = 0;
    
    // Wait for scroll height to stabilize before attempting scroll
    const waitForStableHeight = () => {
      const container = scrollContainerRef.current;
      if (!container) return;
      
      const currentHeight = container.scrollHeight;
      if (currentHeight === lastHeight && currentHeight > 0) {
        stableCount++;
        if (stableCount >= 2) {
          // Height stable, proceed to scroll
          scrollToElement();
          return;
        }
      } else {
        stableCount = 0;
        lastHeight = currentHeight;
      }
      
      if (Date.now() - start < maxWait) {
        requestAnimationFrame(waitForStableHeight);
      } else {
        // Timeout, try scrolling anyway
        scrollToElement();
      }
    };
    
    // Retry until element is found and scroll is stable
    const scrollToElement = () => {
      const container = scrollContainerRef.current;
      if (!container) return;
      
      const element = container.querySelector(`[data-result-id="${scrollToResultId}"]`);
      if (!element) {
        // Element not rendered yet, retry
        if (Date.now() - start < maxWait) {
          requestAnimationFrame(scrollToElement);
        }
        return;
      }
      
      const elementRect = element.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const currentOffset = elementRect.top - containerRect.top;
      // Calculate scroll position to put element at the saved offset
      const scrollTarget = container.scrollTop + currentOffset - scrollToResultOffset;
      
      // Only scroll if target changed significantly (avoid infinite loop)
      if (Math.abs(scrollTarget - lastScrollTarget) > 5) {
        lastScrollTarget = scrollTarget;
        container.scrollTop = scrollTarget;
        
        // Check again next frame in case render shifted things
        if (Date.now() - start < maxWait) {
          requestAnimationFrame(scrollToElement);
        }
      }
    };
    
    // Start by waiting for height to stabilize
    requestAnimationFrame(waitForStableHeight);
  }, [scrollToResultId, scrollToResultOffset]);

  // Spinner overlay component (used for both loading and flash states)
  const SpinnerOverlay = () => (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-900/80 text-slate-400 z-10">
      <svg className="h-8 w-8 animate-spin mb-3" viewBox="0 0 24 24" fill="none">
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
        />
      </svg>
      <span>Searching...</span>
    </div>
  );

  // Empty state: no results yet, not searching
  if (!hasSearched && results.length === 0 && !isSearching) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-slate-500">
        <svg className="h-8 w-8 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
          />
        </svg>
        <span>Enter a search term to find books</span>
      </div>
    );
  }

  // Initial search with no prior results - show centered spinner
  if (isSearching && results.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-slate-400">
        <svg className="h-8 w-8 animate-spin mb-3" viewBox="0 0 24 24" fill="none">
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
        <span>Searching...</span>
      </div>
    );
  }

  if (searchError) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-red-400">
        <svg className="h-8 w-8 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          />
        </svg>
        <span>{searchError}</span>
      </div>
    );
  }

  if (results.length === 0 && hasSearched) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-slate-500">
        <span>No results found</span>
      </div>
    );
  }

  return (
    <div className="relative flex flex-col max-h-full rounded-xl border border-slate-700 bg-slate-800 overflow-hidden">
      {/* Spinner overlay for flash/cache-hit feedback */}
      {isSearching && <SpinnerOverlay />}
      {/* Filter bar */}
      <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-slate-700 min-w-0 shrink-0">
        {/* Left side: Filter, Sort, Include owned */}
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <input
            type="text"
            value={filterText}
            onChange={(e) => onFilterChange(e.target.value)}
            placeholder="Filter results..."
            className="w-48 rounded border border-slate-600 bg-slate-700 px-2 py-1 text-sm text-slate-200 placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
          />
          {onSortChange && (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-slate-500">Sort:</span>
              <select
                value={sortBy}
                onChange={(e) => onSortChange(e.target.value as typeof sortBy)}
                className="rounded border border-slate-600 bg-slate-700 px-2 py-0.5 text-xs text-slate-200 focus:border-emerald-500 focus:outline-none"
              >
                <option value="relevance">Relevance</option>
                <option value="series">Series</option>
                <option value="title">Title</option>
                <option value="year">Year</option>
              </select>
            </div>
          )}
          {onOwnershipFilterChange && (
            <div className="flex items-center gap-1.5">
              <select
                value={ownershipFilter}
                onChange={(e) => onOwnershipFilterChange(e.target.value as OwnershipFilter)}
                className="rounded border border-slate-600 bg-slate-700 px-2 py-0.5 text-xs text-slate-200 focus:border-emerald-500 focus:outline-none"
              >
                <option value="all">All Books</option>
                <option value="missing">Missing</option>
                <option value="owned">Owned</option>
              </select>
            </div>
          )}
        </div>
        {/* Right side: Caching indicator, Result count */}
        <div className="flex items-center gap-2 text-xs text-slate-500 whitespace-nowrap">
          {(enrichmentStatus?.isRunning || enrichmentStatus?.error) && (
            <span 
              className={`flex items-center gap-1.5 ${enrichmentStatus.error ? 'text-red-400' : 'text-emerald-400'}`}
              title={enrichmentStatus.error ?? undefined}
            >
              <span className={`h-2 w-2 rounded-full ${enrichmentStatus.error ? 'bg-red-500' : 'animate-pulse bg-emerald-500'}`} />
              Caching {enrichmentStatus.done}/{enrichmentStatus.total}
            </span>
          )}
          <span>
            {filteredResults.length} of {results.length} result{results.length !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {/* Results list */}
      <div 
        ref={scrollContainerRef}
        data-results-list
        className="flex-1 overflow-y-auto overflow-x-hidden"
      >
        {filteredResults.map((result, index) => {
          const matched = getMatchedBook(result);
          const isOwned = matched?.is_owned ?? false;
          const isInCatalogMissing = matched != null && !matched.is_owned;
          const enrichKey = `${result.provider}:${result.id}`;
          const enriched = enrichedBooks?.get(enrichKey);
          const isEnriched = enriched != null;

          // Get cover URL - prefer our cached cover if owned
          // cover_path is "cache/books/abs_X.jpg", API is /api/images/books/{filename}
          let coverUrl = result.cover_url;
          if (matched?.cover_path) {
            // Extract filename from path like "cache/books/abs_2039.jpg" -> "abs_2039.jpg"
            const filename = matched.cover_path.split('/').pop();
            if (filename) {
              coverUrl = `/api/images/books/${filename}`;
            }
          } else if (coverUrl && coverUrl.includes('/api/covers/')) {
            // Shelfmark cover URL contains base64-encoded original URL in ?url= param
            // Decode and use directly to avoid auth issues
            try {
              const urlParam = new URL(coverUrl).searchParams.get('url');
              if (urlParam) {
                coverUrl = atob(urlParam.replace(/-/g, '+').replace(/_/g, '/'));
              }
            } catch {
              // Failed to decode, keep original (will likely fail to load)
            }
          }

          // Get DB series data
          const dbSeriesData: DbSeriesData | null = matched
            ? {
                series_name: matched.series_name,
                series_position: matched.series_position,
                series_count: matched.series_count,
              }
            : null;

          const isQueued = queuedKeys?.has(`${result.provider}:${result.id}`) ?? false;

          return (
            <SearchResultRow
              key={(result as { _key?: string })._key || `${result.provider}:${result.id}:${index}`}
              result={result}
              index={index}
              coverUrl={coverUrl}
              isOwned={isOwned}
              isInCatalogMissing={isInCatalogMissing}
              isEnriched={isEnriched}
              enrichedData={enriched}
              dbIsbn={matched?.isbn}
              dbSeriesData={dbSeriesData}
              isQueued={isQueued}
              onVisible={onVisible}
              onResultClick={onResultClick}
              onQueueClick={onQueueClick}
              onTitleClick={onTitleClick}
              onAuthorClick={onAuthorClick}
              onSeriesClick={onSeriesClick}
              onInfoClick={onInfoClick}
            />
          );
        })}
      </div>
    </div>
  );
}
