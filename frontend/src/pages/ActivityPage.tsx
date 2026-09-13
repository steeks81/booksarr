/**
 * ActivityPage - Full page with three-panel layout for search and download management
 * 
 * Layout:
 * ┌────────────────────────┬────────────────────────┐
 * │        SEARCH          │        RELEASES        │
 * │  SearchForm            │  ReleaseGroup          │
 * │  SearchResultsList     │  ReleaseGroup          │
 * │  (or BookInfoView)     │  ...                   │
 * ├────────────────────────┴────────────────────────┤
 * │                    DOWNLOADS                     │
 * │  In Progress           │  Finished              │
 * └─────────────────────────────────────────────────┘
 * 
 * Uses the shared useActivitySearch hook for search logic.
 */

import React, { useCallback, useState } from 'react';
import type { ShelfmarkSearchResult } from '../api/shelfmark';
import type { ProviderMatchEntry } from '../api/books';
import {
  useShelfmarkDownload,
  useShelfmarkStatus,
  useShelfmarkCancel,
  useShelfmarkRetry,
  useShelfmarkDismiss,
  useBookSearches,
  queueBookSearch,
  removeBookSearch,
  retryBookSearch,
} from '../api/shelfmark';
import { decodeShelfmarkCoverUrl, getResultCoverUrl } from '../utils/formatUtils';
import type { ShelfmarkRelease, BookSearchEntry } from '../api/shelfmark';
import { useProviderMatch } from '../api/books';
import { useSettings } from '../api/settings';
import SearchForm from '../components/activity/SearchForm';
import SearchResultsList from '../components/activity/SearchResultsList';
import BookInfoView from '../components/activity/BookInfoView';
import ReleaseGroup from '../components/activity/ReleaseGroup';
import DownloadProgress from '../components/activity/DownloadProgress';
import DownloadFinished from '../components/activity/DownloadFinished';
import type { SearchField } from '../types/activity';
import {
  useActivitySearch,
  createInitialSearchState,
} from '../hooks/useActivitySearch';

export default function ActivityPage() {
  // Use the shared search hook with empty initial state (general search)
  const [initialState] = useState(() => createInitialSearchState({ initialField: 'general' }));
  const search = useActivitySearch(initialState);

  // Download error banner state
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // Downloads panel collapse state
  // Quick fix for layout issue: Downloads panel was truncating Releases when many downloads active.
  // Goal: Replace with proper resizable dividers (design.md P1-F13-S1 specifies resizable panels).
  const [downloadsCollapsed, setDownloadsCollapsed] = useState(false);

  // API mutations for downloads
  const downloadMutation = useShelfmarkDownload();
  const cancelMutation = useShelfmarkCancel();
  const retryMutation = useShelfmarkRetry();
  const dismissMutation = useShelfmarkDismiss();

  // Provider match for ownership data (global context - no author filter)
  // Always enabled on Activity page - needed for search results AND release info clicks
  const { data: providerMatchData } = useProviderMatch(null, true);

  // Settings for shelfmark URL
  const { data: settings } = useSettings();

  // Book search queue polling - backend is source of truth for releases
  const { data: bookSearchesData } = useBookSearches(true, 2000);
  const releases = bookSearchesData?.searches || [];
  
  // Build queued keys set for indicator on search results
  const queuedKeys = React.useMemo(() => {
    const keys = new Set<string>();
    for (const entry of releases) {
      keys.add(`${entry.book.provider}:${entry.book.book_id}`);
    }
    return keys;
  }, [releases]);

  // Download status polling - always poll to show downloads from ANY session
  const { data: statusData } = useShelfmarkStatus(true, 2000);

  // --- Releases Handlers ---

  const handleRemoveFromReleases = useCallback(
    async (searchKey: string) => {
      try {
        await removeBookSearch(searchKey);
      } catch {
        // Silent fail - UI will show stale state until next poll
      }
    },
    []
  );

  const handleRetryReleases = useCallback(
    async (entry: BookSearchEntry) => {
      try {
        await retryBookSearch(entry.search_key);
      } catch {
        // Silent fail - UI will show stale state until next poll
      }
    },
    []
  );

  // --- Provider Match Helper ---

  const getMatchedBook = useCallback(
    (result: ShelfmarkSearchResult): ProviderMatchEntry | null => {
      if (!providerMatchData) return null;

      if (result.provider === 'hardcover' && result.id) {
        const match = providerMatchData.by_hardcover_id[result.id];
        if (match) return match;
      }
      if (result.provider === 'googlebooks' && result.id) {
        const match = providerMatchData.by_google_id[result.id];
        if (match) return match;
      }
      if (result.isbn) {
        const normalized = result.isbn.replace(/[-\s]/g, '').toLowerCase();
        const match = providerMatchData.by_isbn[normalized];
        if (match) return match;
      }
      return null;
    },
    [providerMatchData]
  );

  // Helper to get matched book for a release queue entry
  const getMatchedBookForEntry = useCallback(
    (entry: BookSearchEntry): ProviderMatchEntry | null => {
      if (!providerMatchData) return null;

      if (entry.book.provider === 'hardcover' && entry.book.book_id) {
        const match = providerMatchData.by_hardcover_id[entry.book.book_id];
        if (match) return match;
      }
      if (entry.book.provider === 'googlebooks' && entry.book.book_id) {
        const match = providerMatchData.by_google_id[entry.book.book_id];
        if (match) return match;
      }
      return null;
    },
    [providerMatchData]
  );

  const handleFindReleases = useCallback(async () => {
    if (search.state.selectedBook) {
      // Get best cover URL (prefer owned book cover from our DB)
      const matched = getMatchedBook(search.state.selectedBook);
      const coverUrl = getResultCoverUrl(matched?.cover_path, search.state.selectedBook.cover_url);
      try {
        await queueBookSearch({
          provider: search.state.selectedBook.provider || 'unknown',
          book_id: search.state.selectedBook.id,
          title: search.state.selectedBook.title,
          author: search.state.selectedBook.author,
          cover_url: coverUrl,
          year: search.state.selectedBook.year,
          description: search.state.selectedBook.description,
          series_name: search.state.selectedBook.series_name,
          series_position: search.state.selectedBook.series_position,
        });
      } catch {
        // Silent fail - user can retry
      }
      search.setView('search'); // Go back to search so user can see releases panel
    }
  }, [search.state.selectedBook, search.setView, getMatchedBook]);

  // Queue a result directly (from + button in search results)
  const handleQueueClick = useCallback(async (result: ShelfmarkSearchResult) => {
    const matched = getMatchedBook(result);
    const coverUrl = getResultCoverUrl(matched?.cover_path, result.cover_url);
    try {
      await queueBookSearch({
        provider: result.provider || 'unknown',
        book_id: result.id,
        title: result.title,
        author: result.author,
        cover_url: coverUrl,
        year: result.year,
        description: result.description,
        series_name: result.series_name,
        series_position: result.series_position,
      });
    } catch {
      // Silent fail - user can retry
    }
  }, [getMatchedBook]);

  // --- Field Change Handler (with cache save/restore) ---

  const handleFieldChange = useCallback(
    (field: SearchField) => {
      // Save current results to cache before switching fields
      if (search.state.results.length > 0 && search.state.searchField !== field) {
        const scrollInfo = search.getFirstVisibleResultId();
        const updatedCache = {
          ...search.state.resultsCacheByField,
          [search.state.searchField]: {
            results: search.state.results,
            totalResults: search.state.totalResults,
            scrollResultId: scrollInfo?.id ?? null,
            scrollResultOffset: scrollInfo?.offset ?? 0,
            queryText: search.state.queryTextByField[search.state.searchField],
          },
        };

        // Restore from cache if available for new field
        const cached = search.state.resultsCacheByField[field];
        if (cached) {
          search.setState({
            ...search.state,
            searchField: field,
            results: cached.results,
            totalResults: cached.totalResults,
            resultsCacheByField: updatedCache,
          });
        } else {
          search.setState({
            ...search.state,
            searchField: field,
            resultsCacheByField: updatedCache,
          });
        }
      } else {
        // No results to cache, just switch field
        const cached = search.state.resultsCacheByField[field];
        if (cached) {
          search.setState({
            ...search.state,
            searchField: field,
            results: cached.results,
            totalResults: cached.totalResults,
          });
        } else {
          search.setField(field);
        }
      }
    },
    [search]
  );

  // --- Download Handlers ---

  const handleDownload = useCallback(
    async (release: ShelfmarkRelease, entry: BookSearchEntry) => {
      try {
        const response = await downloadMutation.mutateAsync({
          source: release.source,
          source_id: release.source_id,
          title: release.title,
          author: release.author || undefined,
          format: release.format || undefined,
          size: release.size || undefined,
          cover_url: release.cover_url || undefined,
          book_title: entry.book.title,
          book_author: entry.book.author || undefined,
          book_year: entry.book.year || undefined,
          book_provider: entry.book.provider || undefined,
          book_provider_id: entry.book.book_id,
          series_name: entry.book.series_name || undefined,
          series_position: entry.book.series_position || undefined,
        });
        
        // Check for soft errors (SM returns success=false for "already in queue" etc.)
        if (!response.success) {
          setDownloadError(response.error || 'Download failed');
        }
      } catch {
        setDownloadError('Download request failed');
      }
    },
    [downloadMutation]
  );

  const handleCancelDownload = useCallback(
    (sourceId: string) => {
      cancelMutation.mutate(sourceId);
    },
    [cancelMutation]
  );

  const handleRetryDownload = useCallback(
    (sourceId: string) => {
      retryMutation.mutate(sourceId);
    },
    [retryMutation]
  );

  const handleDismissDownload = useCallback(
    (sourceId: string) => {
      dismissMutation.mutate([sourceId]);
    },
    [dismissMutation]
  );

  // Retry a failed release download (from inline retry button)
  const handleRetryReleaseDownload = useCallback(
    (release: ShelfmarkRelease, entry: BookSearchEntry) => {
      setDownloadError(null);
      // Re-initiate download
      handleDownload(release, entry);
    },
    [handleDownload]
  );

  const handleClearAllFinished = useCallback(() => {
    const allIds = [
      ...(statusData?.failed.map((d) => d.source_id) || []),
      ...(statusData?.complete.map((d) => d.source_id) || []),
    ];
    dismissMutation.mutate(allIds);
  }, [statusData, dismissMutation]);

  // Get download status for a release (server state is source of truth)
  const getDownloadStatus = useCallback(
    (sourceId: string): 'idle' | 'downloading' | 'complete' | 'failed' => {
      if (statusData?.in_progress.some((d) => d.source_id === sourceId)) return 'downloading';
      if (statusData?.complete.some((d) => d.source_id === sourceId)) return 'complete';
      if (statusData?.failed.some((d) => d.source_id === sourceId)) return 'failed';
      return 'idle';
    },
    [statusData]
  );

  // Filter finished downloads (just aliases now, but keeps component interface clean)
  const visibleFailed = statusData?.failed || [];
  const visibleComplete = statusData?.complete || [];

  // Handle info click from releases panel
  const handleReleaseInfoClick = useCallback(
    (entry: BookSearchEntry) => {
      const bookAsResult: ShelfmarkSearchResult = {
        id: entry.book.book_id,
        title: entry.book.title,
        author: entry.book.author,
        provider: entry.book.provider,
        cover_url: entry.book.cover_url,
        year: entry.book.year,
        description: entry.book.description,
        series_name: entry.book.series_name,
        series_position: entry.book.series_position,
        format: null,
        size: null,
        source: null,
        download_url: null,
        source_url: null,
        isbn: null,
        series_id: null,
        series_count: null,
        display_fields: null,
      };
      search.setSelectedBook(bookAsResult);
      search.setView('info');
    },
    [search.setSelectedBook, search.setView]
  );

  return (
    <div className="flex h-full flex-col">
      {/* Page header */}
      <div className="border-b border-slate-700 px-6 py-4">
        <h1 className="text-xl font-semibold text-slate-100">Shelfmark Activity</h1>
        {search.enrichmentStatus.isRunning && (
          <div className="mt-1 text-xs text-slate-500">
            Caching series info: {search.enrichmentStatus.done}/{search.enrichmentStatus.total}
            {search.enrichmentStatus.rateLimited && (
              <span className="ml-2 text-amber-400">Rate limited, backing off...</span>
            )}
          </div>
        )}
      </div>

      {/* Main content - three panel layout */}
      <div className="relative flex flex-1 overflow-hidden">
        {/* Download error banner */}
        {downloadError && (
          <div className="absolute left-1/2 top-20 z-50 -translate-x-1/2 transform">
            <div className="flex items-center gap-3 rounded-lg border border-red-500/30 bg-red-900/90 px-4 py-3 shadow-lg">
              <svg className="h-5 w-5 shrink-0 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="text-sm text-red-200">{downloadError}</span>
              <button
                type="button"
                onClick={() => setDownloadError(null)}
                className="ml-2 rounded p-1 text-red-400 hover:bg-red-800 hover:text-red-200 transition-colors"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        )}
        {/* Left panel: Search */}
        <div className="flex w-1/2 flex-col border-r border-slate-700">
          <div className="p-4">
            <SearchForm
              searchField={search.state.searchField}
              queryText={search.state.queryTextByField[search.state.searchField]}
              manualQuery={search.state.manualQuery}
              isSearching={search.state.isSearching}
              shelfmarkUrl={settings?.shelfmark_url}
              canGoBack={search.canGoBack}
              canGoForward={search.canGoForward}
              onFieldChange={handleFieldChange}
              onQueryChange={(query) => search.setQuery(search.state.searchField, query)}
              onManualQueryChange={search.setManualQuery}
              onSearch={() => search.handleSearch(undefined, undefined, undefined, true)}
              onHistoryBack={search.handleHistoryBack}
              onHistoryForward={search.handleHistoryForward}
            />
          </div>

          <div className="flex-1 overflow-hidden">
            {search.state.view === 'info' && search.state.selectedBook ? (
              <div className="h-full overflow-y-auto p-4">
                <BookInfoView
                  book={search.state.selectedBook}
                  matchedBook={getMatchedBook(search.state.selectedBook)}
                  onBackClick={search.handleBackToSearch}
                  onSeriesClick={search.handleSeriesClick}
                  onFindReleasesClick={handleFindReleases}
                  showFindReleasesButton={true}
                  isQueued={queuedKeys.has(`${search.state.selectedBook.provider}:${search.state.selectedBook.id}`)}
                />
              </div>
            ) : (
              <SearchResultsList
                results={search.state.results}
                totalResults={search.state.totalResults}
                filterText={search.state.filterText}
                isSearching={search.state.isSearching}
                hasSearched={search.state.hasSearched}
                searchError={search.state.searchError}
                providerMatchByHcId={providerMatchData?.by_hardcover_id}
                providerMatchByGoogleId={providerMatchData?.by_google_id}
                providerMatchByIsbn={providerMatchData?.by_isbn}
                enrichedBooks={search.enrichedBooks}
                enrichmentStatus={search.enrichmentStatus}
                sortBy={search.state.sortBy}
                onSortChange={search.setSortBy}
                scrollToResultId={search.state.resultsCacheByField[search.state.searchField]?.scrollResultId}
                scrollToResultOffset={search.state.resultsCacheByField[search.state.searchField]?.scrollResultOffset ?? 0}
                onFilterChange={search.setFilterText}
                onVisible={search.handleRowVisible}
                onResultClick={search.handleInfoClick}
                onQueueClick={handleQueueClick}
                onInfoClick={search.handleInfoClick}
                onTitleClick={search.handleTitleClick}
                onAuthorClick={search.handleAuthorClick}
                onSeriesClick={search.handleSeriesClick}
                ownershipFilter={search.ownershipFilter}
                onOwnershipFilterChange={search.setOwnershipFilter}
                queuedKeys={queuedKeys}
              />
            )}
          </div>
        </div>

        {/* Right panel: Releases */}
        <div className="flex w-1/2 flex-col">
          <div className="border-b border-slate-700 px-4 py-3">
            <h2 className="text-sm font-medium text-slate-400">Releases Queue</h2>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            {releases.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-slate-500">
                Click a search result to find releases
              </div>
            ) : (
              <div className="space-y-3">
                {releases.map((entry) => {
                  const matched = getMatchedBookForEntry(entry);
                  const isOwned = matched?.is_owned === true;
                  const isInCatalog = matched != null && !isOwned;
                  return (
                    <ReleaseGroup
                      key={entry.search_key}
                      entry={entry}
                      getDownloadStatus={getDownloadStatus}
                      onDownload={(release) => handleDownload(release, entry)}
                      onRetryDownload={(release) => handleRetryReleaseDownload(release, entry)}
                      onCancelDownload={(release) => handleCancelDownload(release.source_id)}
                      onRemove={() => handleRemoveFromReleases(entry.search_key)}
                      onRetryFetch={() => handleRetryReleases(entry)}
                      onInfoClick={() => handleReleaseInfoClick(entry)}
                      isOwned={isOwned}
                      isInCatalog={isInCatalog}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom panel: Downloads (collapsible) */}
      {(statusData?.in_progress.length || visibleFailed.length > 0 || visibleComplete.length > 0) && (
        <div className="border-t border-slate-700">
          {/* Collapsible header */}
          <button
            type="button"
            onClick={() => setDownloadsCollapsed(!downloadsCollapsed)}
            className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-slate-700/30 transition-colors"
          >
            <svg
              className={`h-4 w-4 text-slate-400 transition-transform ${downloadsCollapsed ? '' : 'rotate-90'}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            <span className="text-sm font-medium text-slate-400">Downloads</span>
            {statusData?.in_progress && statusData.in_progress.length > 0 && (
              <span className="rounded-full bg-sky-500/20 px-2 py-0.5 text-xs text-sky-400">
                {statusData.in_progress.length} active
              </span>
            )}
            {visibleFailed.length > 0 && (
              <span className="rounded-full bg-red-500/20 px-2 py-0.5 text-xs text-red-400">
                {visibleFailed.length} failed
              </span>
            )}
            {visibleComplete.length > 0 && (
              <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs text-emerald-400">
                {visibleComplete.length} complete
              </span>
            )}
          </button>

          {/* Content (hidden when collapsed, max-height with scroll when expanded) */}
          {!downloadsCollapsed && (
            <div className="max-h-48 overflow-y-auto px-4 pb-4">
              <div className="flex gap-6">
                {/* In Progress */}
                {statusData?.in_progress && statusData.in_progress.length > 0 && (
                  <DownloadProgress
                    items={statusData.in_progress}
                    onCancel={handleCancelDownload}
                  />
                )}

                {/* Finished */}
                {(visibleFailed.length > 0 || visibleComplete.length > 0) && (
                  <DownloadFinished
                    failed={visibleFailed}
                    complete={visibleComplete}
                    onRetry={handleRetryDownload}
                    onDismiss={handleDismissDownload}
                    onClearAll={handleClearAllFinished}
                  />
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
