/**
 * ActivityOverlay - Scoped overlay for searching from author page context
 *
 * S7-style inline flow with bulk navigation for multiple books.
 * Uses the shared useActivitySearch hook for search logic.
 *
 * Key behaviors:
 * - Per-field query text (switch Author→Series→Author, text preserved)
 * - Per-field results cache (switch tabs without re-searching)
 * - Skip redundant searches (click same series link twice → no new request)
 * - Per-book state in bulk mode (navigate away and back, state preserved)
 * - Save current results to cache before switching fields
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import type { ShelfmarkSearchResult } from '../../api/shelfmark';
import type { ProviderMatchEntry } from '../../api/books';
import { queueBookSearch, useBookSearches } from '../../api/shelfmark';
import { decodeShelfmarkCoverUrl, getResultCoverUrl } from '../../utils/formatUtils';
import { useProviderMatch } from '../../api/books';
import { useSettings } from '../../api/settings';
import SearchForm from './SearchForm';
import SearchResultsList from './SearchResultsList';
import BookInfoView from './BookInfoView';
import type { SearchField } from '../../types/activity';
import {
  useActivitySearch,
  createInitialSearchState,
  type SearchState,
} from '../../hooks/useActivitySearch';
import { getPersistedSortBy } from '../../types/activity';

// --- Types ---

export interface BulkBook {
  id: string; // Unique identifier for this book in bulk nav
  title: string;
  authorName: string | null;
  authorId: number | null;
  authorHardcoverId?: number | null;
  seriesHardcoverId?: number | null;
  seriesName?: string | null;
  _searchField?: 'author' | 'title' | 'series'; // Hint for initial search field
  _ownershipFilter?: 'all' | 'missing' | 'owned'; // Hint for ownership filter
  _isSeriesSearch?: boolean; // True if this is a collapsed series search
  _seriesBookCount?: number; // Number of books selected from this series
}

interface ActivityOverlayProps {
  books: BulkBook[];
  authorId: number | null; // For provider match scoping
  open: boolean;
  onClose: () => void;
}

// Create initial state for a book
function createInitialBookState(book: BulkBook): SearchState {
  const field = book._searchField || 'title';

  // Prefill all fields like S7 does
  const generalPrefill =
    field === 'series'
      ? [book.authorName || '', book.seriesName || ''].filter(Boolean).join(' ').trim()
      : [book.authorName || '', book.title].filter(Boolean).join(' ').trim();

  return createInitialSearchState({
    initialField: field,
    prefill: {
      general: generalPrefill,
      author: book.authorName || '',
      title: book.title,
      series: book.seriesName || '',
      isbn: '',
    },
  });
}

// --- Main Component ---

export default function ActivityOverlay({ books, authorId, open, onClose }: ActivityOverlayProps) {
  // --- Refs for caches (survive re-renders, cleared on unmount) ---

  // Per-book state cache (stores full SearchState per book for multi-book navigation)
  const bookCacheRef = useRef<Map<string, SearchState>>(new Map());

  // Track which books have been auto-searched (for bulk nav - each book needs its own tracking)
  const autoSearchedBooksRef = useRef<Set<string>>(new Set());

  // --- State ---

  // Bulk navigation
  const [bulkIndex, setBulkIndex] = useState(0);

  // Current book
  const currentBook = books[bulkIndex];
  const currentBookId = currentBook?.id;

  // Get or create state for current book
  const getBookState = useCallback(
    (bookId: string): SearchState => {
      const cached = bookCacheRef.current.get(bookId);
      if (cached) return cached;

      const book = books.find((b) => b.id === bookId);
      if (!book) {
        return createInitialBookState({ id: bookId, title: '', authorName: null, authorId: null });
      }

      const initial = createInitialBookState(book);
      bookCacheRef.current.set(bookId, initial);
      return initial;
    },
    [books]
  );

  // Initial state for the hook
  const [initialState] = useState<SearchState>(() =>
    currentBookId ? getBookState(currentBookId) : createInitialBookState(books[0] || { id: '', title: '', authorName: null, authorId: null })
  );

  // Use the shared search hook
  const search = useActivitySearch(initialState, {
    authorHardcoverId: currentBook?.authorHardcoverId,
    authorName: currentBook?.authorName,
    seriesHardcoverId: currentBook?.seriesHardcoverId,
    seriesName: currentBook?.seriesName,
    bookCacheRef: books.length > 1 ? bookCacheRef : undefined,
    onStateChange: (state) => {
      // Sync state changes back to bulk cache
      if (currentBookId) {
        bookCacheRef.current.set(currentBookId, state);
      }
    },
  });

  // Confirmation banner state
  const [confirmationBanner, setConfirmationBanner] = useState<{
    title: string;
    type: 'success' | 'warning' | 'error';
    message: string;
  } | null>(null);
  const bannerTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear banner timeout on unmount
  useEffect(() => {
    return () => {
      if (bannerTimeoutRef.current) {
        clearTimeout(bannerTimeoutRef.current);
      }
    };
  }, []);

  const dismissBanner = useCallback(() => {
    if (bannerTimeoutRef.current) {
      clearTimeout(bannerTimeoutRef.current);
      bannerTimeoutRef.current = null;
    }
    setConfirmationBanner(null);
  }, []);

  // --- API hooks ---

  const { data: providerMatchData } = useProviderMatch(authorId, open);
  const { data: settings } = useSettings();
  
  // Queue data for "already queued" indicator
  const { data: bookSearchesData } = useBookSearches(open, 5000);
  const queuedKeys = React.useMemo(() => {
    const keys = new Set<string>();
    for (const entry of bookSearchesData?.searches || []) {
      // Build key from provider:book_id (matches search result format)
      keys.add(`${entry.book.provider}:${entry.book.book_id}`);
    }
    return keys;
  }, [bookSearchesData]);

  // --- Sync state when switching books in bulk nav ---

  useEffect(() => {
    if (currentBookId) {
      const bookState = getBookState(currentBookId);
      search.setState(bookState);
      
      // Apply ownership filter from bulk book hint (smart bulk mode)
      if (currentBook?._ownershipFilter) {
        search.setOwnershipFilter(currentBook._ownershipFilter);
      }
      
      // Auto-search if this book hasn't been searched yet
      // Pass field and query explicitly since setState is async
      if (!bookState.hasSearched && !autoSearchedBooksRef.current.has(currentBookId)) {
        autoSearchedBooksRef.current.add(currentBookId);
        const field = bookState.searchField;
        const query = bookState.queryTextByField[field];
        if (query) {
          search.handleSearch(field, query);
        }
      }
    }
  }, [currentBookId, getBookState, currentBook?._ownershipFilter]);

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

  const handleFindReleases = useCallback(async () => {
    if (!search.state.selectedBook) return;
    
    const result = search.state.selectedBook;
    
    // Clear any existing banner timeout
    if (bannerTimeoutRef.current) {
      clearTimeout(bannerTimeoutRef.current);
      bannerTimeoutRef.current = null;
    }

    // Get best cover URL (prefer owned book cover from our DB)
    const matched = getMatchedBook(result);
    const coverUrl = getResultCoverUrl(matched?.cover_path, result.cover_url);

    try {
      const response = await queueBookSearch({
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

      if (response.success) {
        setConfirmationBanner({
          title: result.title,
          type: 'success',
          message: 'Added to releases queue',
        });
        bannerTimeoutRef.current = setTimeout(() => setConfirmationBanner(null), 10000);
      } else if (response.error === 'already_queued') {
        setConfirmationBanner({
          title: result.title,
          type: 'warning',
          message: 'Already in queue',
        });
        bannerTimeoutRef.current = setTimeout(() => setConfirmationBanner(null), 10000);
      } else {
        setConfirmationBanner({
          title: result.title,
          type: 'error',
          message: response.error || 'Failed to queue',
        });
      }
    } catch {
      setConfirmationBanner({
        title: result.title,
        type: 'error',
        message: 'Failed to queue book search',
      });
    }
  }, [search.state.selectedBook, getMatchedBook]);

  // Queue a result directly (from + button in search results)
  const handleQueueClick = useCallback(async (result: ShelfmarkSearchResult) => {
    // Clear any existing banner timeout
    if (bannerTimeoutRef.current) {
      clearTimeout(bannerTimeoutRef.current);
      bannerTimeoutRef.current = null;
    }

    // Get best cover URL (prefer owned book cover from our DB)
    const matched = getMatchedBook(result);
    const coverUrl = getResultCoverUrl(matched?.cover_path, result.cover_url);

    try {
      const response = await queueBookSearch({
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

      if (response.success) {
        setConfirmationBanner({
          title: result.title,
          type: 'success',
          message: 'Added to releases queue',
        });
        bannerTimeoutRef.current = setTimeout(() => setConfirmationBanner(null), 10000);
      } else if (response.error === 'already_queued') {
        setConfirmationBanner({
          title: result.title,
          type: 'warning',
          message: 'Already in queue',
        });
        bannerTimeoutRef.current = setTimeout(() => setConfirmationBanner(null), 10000);
      } else {
        setConfirmationBanner({
          title: result.title,
          type: 'error',
          message: response.error || 'Failed to queue',
        });
      }
    } catch {
      setConfirmationBanner({
        title: result.title,
        type: 'error',
        message: 'Failed to queue book search',
      });
    }
  }, [getMatchedBook]);

  // --- Bulk Navigation ---

  const handleBulkPrev = useCallback(() => {
    if (bulkIndex > 0) {
      dismissBanner();
      // Save current state with updated scroll position before switching
      if (currentBookId) {
        const scrollInfo = search.getFirstVisibleResultId();
        const field = search.state.searchField;
        const stateToSave: SearchState = {
          ...search.state,
          resultsCacheByField: {
            ...search.state.resultsCacheByField,
            [field]: search.state.resultsCacheByField[field]
              ? {
                  ...search.state.resultsCacheByField[field]!,
                  scrollResultId: scrollInfo?.id ?? null,
                  scrollResultOffset: scrollInfo?.offset ?? 0,
                }
              : search.state.results.length > 0
                ? {
                    results: search.state.results,
                    totalResults: search.state.totalResults,
                    scrollResultId: scrollInfo?.id ?? null,
                    scrollResultOffset: scrollInfo?.offset ?? 0,
                    queryText: search.state.queryTextByField[field],
                  }
                : null,
          },
        };
        bookCacheRef.current.set(currentBookId, stateToSave);
      }
      setBulkIndex(bulkIndex - 1);
    }
  }, [bulkIndex, currentBookId, search, dismissBanner]);

  const handleBulkNext = useCallback(() => {
    if (bulkIndex < books.length - 1) {
      dismissBanner();
      // Save current state with updated scroll position before switching
      if (currentBookId) {
        const scrollInfo = search.getFirstVisibleResultId();
        const field = search.state.searchField;
        const stateToSave: SearchState = {
          ...search.state,
          resultsCacheByField: {
            ...search.state.resultsCacheByField,
            [field]: search.state.resultsCacheByField[field]
              ? {
                  ...search.state.resultsCacheByField[field]!,
                  scrollResultId: scrollInfo?.id ?? null,
                  scrollResultOffset: scrollInfo?.offset ?? 0,
                }
              : search.state.results.length > 0
                ? {
                    results: search.state.results,
                    totalResults: search.state.totalResults,
                    scrollResultId: scrollInfo?.id ?? null,
                    scrollResultOffset: scrollInfo?.offset ?? 0,
                    queryText: search.state.queryTextByField[field],
                  }
                : null,
          },
        };
        bookCacheRef.current.set(currentBookId, stateToSave);
      }
      setBulkIndex(bulkIndex + 1);
    }
  }, [bulkIndex, books.length, currentBookId, search, dismissBanner]);

  // --- Effects ---

  // Dismiss banner on context changes (new search, field change, view change, history nav)
  useEffect(() => {
    dismissBanner();
  }, [search.state.searchField, search.state.view, search.state.isSearching, search.state.historyIndex]);

  // Clear caches when dialog closes
  useEffect(() => {
    if (!open) {
      bookCacheRef.current.clear();
      autoSearchedBooksRef.current.clear();
      setBulkIndex(0);
    }
  }, [open]);

  // ESC key to close overlay
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  // Click outside handler (on backdrop)
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  // --- Render ---

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={handleBackdropClick}
    >
      <div className="flex h-[90vh] w-full max-w-4xl flex-col rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
        {/* Header with bulk nav */}
        <div className="flex items-start justify-between border-b border-slate-700 px-6 py-4">
          {/* Bulk navigation */}
          {books.length > 1 && (
            <div className="flex items-center shrink-0">
              <div className="flex items-center gap-1 rounded-lg border border-slate-600 bg-slate-700 px-1">
                <button
                  type="button"
                  onClick={handleBulkPrev}
                  disabled={bulkIndex === 0 || search.state.isSearching}
                  className="rounded p-1.5 text-slate-400 hover:bg-slate-600 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
                  title="Previous book"
                >
                  <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M15 19l-7-7 7-7"
                    />
                  </svg>
                </button>
                <span className="min-w-[4rem] text-center text-sm text-slate-300">
                  {bulkIndex + 1} of {books.length}
                </span>
                <button
                  type="button"
                  onClick={handleBulkNext}
                  disabled={bulkIndex === books.length - 1 || search.state.isSearching}
                  className="rounded p-1.5 text-slate-400 hover:bg-slate-600 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
                  title="Next book"
                >
                  <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                </button>
              </div>
            </div>
          )}

          {/* Title - left side (fixed width ~50%) */}
          <div className="w-1/2 px-4">
            <h2 className="text-lg font-semibold text-slate-100">Search Shelfmark</h2>
            {/* Author/Series mode: show on left under header */}
            {currentBook?._searchField === 'author' && (
              <div className="mt-1">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Author: </span>
                <span className="text-sm text-slate-200">{currentBook.title}</span>
              </div>
            )}
            {currentBook?._searchField === 'series' && (
              <div className="mt-1">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Series: </span>
                <span className="text-sm text-slate-200">{currentBook.title}</span>
                {currentBook._seriesBookCount && currentBook._seriesBookCount > 1 && (
                  <span className="ml-2 text-xs text-slate-400">({currentBook._seriesBookCount} books selected)</span>
                )}
              </div>
            )}
            {/* Reserve space when no subtitle to keep header aligned top */}
            {currentBook?._searchField !== 'author' && currentBook?._searchField !== 'series' && (
              <div className="mt-1 h-5" />
            )}
          </div>

          {/* Book info/detail - right side (shows for all modes when in info view, or for book mode in search view) */}
          <div className="w-1/2 px-4">
            {search.state.view === 'info' && search.state.selectedBook ? (
              <>
                <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Book Detail</div>
                <div className="text-sm text-slate-200 truncate" title={search.state.selectedBook.title}>
                  {search.state.selectedBook.title}
                </div>
                {search.state.selectedBook.author && (
                  <div className="text-sm text-slate-400 truncate">
                    {search.state.selectedBook.author}
                  </div>
                )}
              </>
            ) : currentBook?._searchField !== 'author' && currentBook?._searchField !== 'series' ? (
              <>
                <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Book Info</div>
                <div className="text-sm text-slate-200 truncate" title={currentBook?.title}>
                  {currentBook?.title}
                </div>
                {currentBook?.authorName && (
                  <div className="text-sm text-slate-400 truncate">
                    {currentBook.authorName}
                  </div>
                )}
              </>
            ) : null}
          </div>

          {/* Close button */}
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-md border border-slate-600 bg-slate-800 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-700"
          >
            Close
          </button>
        </div>

        {/* Content */}
        <div className="flex flex-1 flex-col overflow-hidden p-6">
          {/* Search form (only in search view) */}
          {search.state.view === 'search' && (
            <div className="mb-4 flex-shrink-0">
              <SearchForm
                searchField={search.state.searchField}
                queryText={search.state.queryTextByField[search.state.searchField]}
                manualQuery={search.state.manualQuery}
                isSearching={search.state.isSearching}
                shelfmarkUrl={settings?.shelfmark_url}
                canGoBack={search.canGoBack}
                canGoForward={search.canGoForward}
                onFieldChange={search.handleFieldChange}
                onQueryChange={(query) => search.setQuery(search.state.searchField, query)}
                onManualQueryChange={search.setManualQuery}
                onSearch={() => search.handleSearch(undefined, undefined, undefined, true)}
                onHistoryBack={search.handleHistoryBack}
                onHistoryForward={search.handleHistoryForward}
                debug={{
                  queryTextByField: search.state.queryTextByField,
                  historyStack: search.state.historyStack,
                  historyIndex: search.state.historyIndex,
                }}
              />
            </div>
          )}

          {/* View content */}
          <div className="min-h-0 flex-1 overflow-hidden">
            {search.state.view === 'search' && (
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
                scrollToResultId={
                  search.state.resultsCacheByField[search.state.searchField]?.scrollResultId
                }
                scrollToResultOffset={
                  search.state.resultsCacheByField[search.state.searchField]?.scrollResultOffset ?? 0
                }
                onFilterChange={search.setFilterText}
                onVisible={search.handleRowVisible}
                onResultClick={search.handleInfoClick}
                onQueueClick={handleQueueClick}
                onInfoClick={search.handleInfoClick}
                onTitleClick={search.handleTitleClick}
                onAuthorClick={search.handleAuthorClick}
                onSeriesClick={search.handleSeriesClick}
                sortBy={search.state.sortBy}
                onSortChange={search.setSortBy}
                ownershipFilter={search.ownershipFilter}
                onOwnershipFilterChange={search.setOwnershipFilter}
                queuedKeys={queuedKeys}
              />
            )}

            {search.state.view === 'info' && search.state.selectedBook && (
              <BookInfoView
                book={search.state.selectedBook}
                matchedBook={getMatchedBook(search.state.selectedBook)}
                onBackClick={search.handleBackToSearch}
                onSeriesClick={search.handleSeriesClick}
                isQueued={queuedKeys.has(`${search.state.selectedBook.provider}:${search.state.selectedBook.id}`)}
              />
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-end gap-3 border-t border-slate-700 px-6 py-4">
          {search.state.view === 'info' && search.state.selectedBook && (
            <button
              type="button"
              onClick={handleFindReleases}
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
            >
              Find Releases
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-600 bg-slate-800 px-4 py-2 text-sm text-slate-200 hover:bg-slate-700"
          >
            Done
          </button>
        </div>

        {/* Confirmation banner */}
        {confirmationBanner && (
          <div className={`border-t px-6 py-3 ${
            confirmationBanner.type === 'success' 
              ? 'border-slate-700 bg-emerald-900/30' 
              : confirmationBanner.type === 'warning'
              ? 'border-amber-700/50 bg-amber-900/30'
              : 'border-red-700/50 bg-red-900/30'
          }`}>
            <div className="flex items-center gap-2">
              {confirmationBanner.type === 'success' && (
                <svg
                  className="h-5 w-5 text-emerald-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              )}
              {confirmationBanner.type === 'warning' && (
                <svg
                  className="h-5 w-5 text-amber-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                  />
                </svg>
              )}
              {confirmationBanner.type === 'error' && (
                <svg
                  className="h-5 w-5 text-red-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              )}
              <span className={`text-sm ${
                confirmationBanner.type === 'success' 
                  ? 'text-emerald-300' 
                  : confirmationBanner.type === 'warning'
                  ? 'text-amber-300'
                  : 'text-red-300'
              }`}>
                "{confirmationBanner.title}" — {confirmationBanner.message}
              </span>
              {/* Link to Activity (not shown for errors) */}
              {confirmationBanner.type !== 'error' && (
                <Link
                  to="/activity"
                  className={`ml-auto text-sm ${
                    confirmationBanner.type === 'success'
                      ? 'text-emerald-400 hover:text-emerald-300'
                      : 'text-amber-400 hover:text-amber-300'
                  }`}
                >
                  View in Activity Page →
                </Link>
              )}
              {/* Dismiss button */}
              <button
                type="button"
                onClick={dismissBanner}
                className={`p-1 rounded hover:bg-slate-700/50 ${
                  confirmationBanner.type !== 'error' ? '' : 'ml-auto'
                } ${
                  confirmationBanner.type === 'success'
                    ? 'text-emerald-400 hover:text-emerald-300'
                    : confirmationBanner.type === 'warning'
                    ? 'text-amber-400 hover:text-amber-300'
                    : 'text-red-400 hover:text-red-300'
                }`}
                title="Dismiss"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
