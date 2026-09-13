/**
 * useActivitySearch - Shared search logic for ActivityOverlay and ActivityPage
 *
 * Handles:
 * - Per-field query text
 * - Per-field results cache with scroll restoration
 * - Search execution with dedup checking
 * - Field click handlers (title/author/series)
 * - Enrichment integration
 *
 * This hook extracts the common search behavior from both components.
 */

import { useCallback, useState, useRef, useEffect } from 'react';
import type { ShelfmarkSearchResult } from '../api/shelfmark';
import { useShelfmarkSearch } from '../api/shelfmark';
import { sanitizeResults } from '../utils/searchUtils';
import { preloadFirstCovers } from '../utils/imagePreloader';
import { useVisibilityEnrichment } from './useVisibilityEnrichment';
import type { SearchField, SortBy, OwnershipFilter } from '../types/activity';
import { getPersistedSortBy, persistSortBy, getPersistedOwnershipFilter, persistOwnershipFilter } from '../types/activity';

// DOM selector for the results list container (used for scroll operations)
const RESULTS_LIST_SELECTOR = '[data-results-list]';

// Search parameters for Shelfmark API
interface ShelfmarkSearchParams {
  query: string;
  media_type: 'ebook' | 'audiobook';
  author?: string;
  title?: string;
  series?: string;
  isbn?: string;
  author_hardcover_id?: number | null;
  series_hardcover_id?: number | null;
}

// Per-field results cache entry
export interface CachedFieldResults {
  results: ShelfmarkSearchResult[];
  totalResults: number;
  scrollResultId: string | null;
  scrollResultOffset: number;
  queryText: string;
}

// History entry stores field and ALL queryText values for complete state restoration
export interface HistoryEntry {
  field: SearchField;
  queryTextByField: Record<SearchField, string>;  // Snapshot of all field values
}

// Full search state
export interface SearchState {
  searchField: SearchField;
  queryTextByField: Record<SearchField, string>;
  results: ShelfmarkSearchResult[];
  totalResults: number;
  resultsCacheByField: Record<SearchField, CachedFieldResults | null>;
  view: 'search' | 'info';
  selectedBook: ShelfmarkSearchResult | null;
  hasSearched: boolean;
  isSearching: boolean;
  searchError: string | null;
  manualQuery: boolean;
  filterText: string;
  sortBy: SortBy;
  // History navigation (stores field + queryText pairs)
  historyStack: HistoryEntry[];
  historyIndex: number;
}

// Options for creating initial state
export interface InitialStateOptions {
  initialField?: SearchField;
  prefill?: {
    general?: string;
    author?: string;
    title?: string;
    series?: string;
    isbn?: string;
  };
}

// Create initial state
export function createInitialSearchState(options: InitialStateOptions = {}): SearchState {
  const field = options.initialField || 'general';
  const prefill = options.prefill || {};

  return {
    searchField: field,
    queryTextByField: {
      general: prefill.general || '',
      author: prefill.author || '',
      title: prefill.title || '',
      series: prefill.series || '',
      isbn: prefill.isbn || '',
    },
    results: [],
    totalResults: 0,
    resultsCacheByField: {
      general: null,
      author: null,
      title: null,
      series: null,
      isbn: null,
    },
    view: 'search',
    selectedBook: null,
    hasSearched: false,
    isSearching: false,
    searchError: null,
    manualQuery: false,
    filterText: '',
    sortBy: getPersistedSortBy(),
    historyStack: [],
    historyIndex: -1,
  };
}

// Hook options
export interface UseActivitySearchOptions {
  // Optional Hardcover IDs for enhanced search (used by overlay)
  authorHardcoverId?: number | null;
  authorName?: string | null; // Original author name - only use HC ID when query matches
  seriesHardcoverId?: number | null;
  seriesName?: string | null; // Original series name - only use HC ID when query matches
  // Cross-book cache for multi-book mode (scans for matching results across books)
  bookCacheRef?: React.MutableRefObject<Map<string, SearchState>>;
  // Callback when search state changes (for syncing to external cache)
  onStateChange?: (state: SearchState) => void;
}

// Hook return type
export interface UseActivitySearchReturn {
  // State
  state: SearchState;
  // State setters
  setField: (field: SearchField) => void;
  setQuery: (field: SearchField, query: string) => void;
  setManualQuery: (manual: boolean) => void;
  setFilterText: (text: string) => void;
  setSortBy: (sort: SortBy) => void;
  setSelectedBook: (book: ShelfmarkSearchResult | null) => void;
  setView: (view: 'search' | 'info') => void;
  // Replace entire state (for bulk navigation)
  setState: (state: SearchState) => void;
  // Search actions
  handleSearch: (overrideField?: SearchField, overrideQuery?: string, overrideHcId?: number | null, forceSearch?: boolean, skipHistoryUpdate?: boolean) => Promise<void>;
  // Field change handler (dropdown switch with cache/history management)
  handleFieldChange: (field: SearchField) => void;
  // Field click handlers
  handleTitleClick: (title: string, author: string | null, seriesName: string | null) => void;
  handleAuthorClick: (author: string, title: string | null, seriesName: string | null) => void;
  handleSeriesClick: (seriesName: string, author: string | null, seriesId: string | null) => void;
  // Info view handlers
  handleInfoClick: (result: ShelfmarkSearchResult) => void;
  handleBackToSearch: () => void;
  // History navigation
  canGoBack: boolean;
  canGoForward: boolean;
  handleHistoryBack: () => void;
  handleHistoryForward: () => void;
  // Scroll position capture
  getFirstVisibleResultId: () => { id: string; offset: number } | null;
  // Enrichment
  enrichedBooks: Map<string, import('../components/activity/SearchResultRow').EnrichedData>;
  enrichmentStatus: { done: number; total: number; isRunning: boolean; rateLimited?: boolean; error?: string | null };
  handleRowVisible: (result: ShelfmarkSearchResult) => void;
  clearEnrichment: () => void;
  // Global preferences
  ownershipFilter: OwnershipFilter;
  setOwnershipFilter: (filter: OwnershipFilter) => void;
}

export function useActivitySearch(
  initialState: SearchState,
  options: UseActivitySearchOptions = {}
): UseActivitySearchReturn {
  const { authorHardcoverId, authorName, seriesHardcoverId, seriesName, bookCacheRef, onStateChange } = options;

  // Internal state
  const [state, setStateInternal] = useState<SearchState>(initialState);
  
  // Ref for accessing current state in callbacks without stale closures
  const stateRef = useRef<SearchState>(state);
  stateRef.current = state;

  // Global preferences (persisted to localStorage)
  const [ownershipFilter, setOwnershipFilterState] = useState(getPersistedOwnershipFilter);

  // API hooks
  const searchMutation = useShelfmarkSearch();

  // Visibility-based series enrichment
  const { enrichedBooks, enrichmentStatus, handleRowVisible, clearEnrichment } =
    useVisibilityEnrichment();

  // Ref for flash spinner timeout cleanup
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Flash the spinner briefly to indicate click was registered (for duplicate search clicks)
  const flashSearchingState = useCallback(() => {
    // Clear any existing timeout
    if (flashTimeoutRef.current) {
      clearTimeout(flashTimeoutRef.current);
    }
    // Set searching state
    setStateInternal((prev) => ({ ...prev, isSearching: true }));
    // Clear after brief delay
    flashTimeoutRef.current = setTimeout(() => {
      setStateInternal((prev) => ({ ...prev, isSearching: false }));
      flashTimeoutRef.current = null;
    }, 150);
  }, []);

  // Cleanup flash timeout on unmount to prevent setState on unmounted component
  useEffect(() => {
    return () => {
      if (flashTimeoutRef.current) {
        clearTimeout(flashTimeoutRef.current);
      }
    };
  }, []);

  // Update state and notify
  const setState = useCallback(
    (newState: SearchState) => {
      setStateInternal(newState);
      onStateChange?.(newState);
    },
    [onStateChange]
  );

  const updateState = useCallback(
    (updater: (prev: SearchState) => SearchState) => {
      setStateInternal((prev) => {
        const next = updater(prev);
        onStateChange?.(next);
        return next;
      });
    },
    [onStateChange]
  );

  // --- Setters ---

  const setField = useCallback(
    (field: SearchField) => {
      updateState((prev) => ({ ...prev, searchField: field }));
    },
    [updateState]
  );

  const setQuery = useCallback(
    (field: SearchField, query: string) => {
      updateState((prev) => ({
        ...prev,
        queryTextByField: { ...prev.queryTextByField, [field]: query },
      }));
    },
    [updateState]
  );

  const setManualQuery = useCallback(
    (manual: boolean) => {
      updateState((prev) => ({ ...prev, manualQuery: manual }));
    },
    [updateState]
  );

  const setFilterText = useCallback(
    (text: string) => {
      updateState((prev) => ({ ...prev, filterText: text }));
    },
    [updateState]
  );

  const setSortBy = useCallback(
    (sort: SortBy) => {
      persistSortBy(sort);
      updateState((prev) => ({ ...prev, sortBy: sort }));
      // Scroll to top when sort changes
      document.querySelector(RESULTS_LIST_SELECTOR)?.scrollTo(0, 0);
    },
    [updateState]
  );

  const setSelectedBook = useCallback(
    (book: ShelfmarkSearchResult | null) => {
      updateState((prev) => ({ ...prev, selectedBook: book }));
    },
    [updateState]
  );

  const setView = useCallback(
    (view: 'search' | 'info') => {
      updateState((prev) => ({ ...prev, view }));
    },
    [updateState]
  );

  const setOwnershipFilter = useCallback((filter: OwnershipFilter) => {
    setOwnershipFilterState(filter);
    persistOwnershipFilter(filter);
    // Scroll to top when filter changes
    document.querySelector(RESULTS_LIST_SELECTOR)?.scrollTo(0, 0);
  }, []);

  // --- Scroll Position Capture ---

  const getFirstVisibleResultId = useCallback((): { id: string; offset: number } | null => {
    const container = document.querySelector(RESULTS_LIST_SELECTOR);
    if (!container || state.results.length === 0) return null;

    const containerRect = container.getBoundingClientRect();
    for (const result of state.results) {
      const el = document.getElementById(`result-row-${result.id}`);
      if (el) {
        const elRect = el.getBoundingClientRect();
        const offsetFromTop = elRect.top - containerRect.top;
        // Row is visible if its top is within the container viewport
        if (offsetFromTop >= -50 && offsetFromTop < containerRect.height) {
          return { id: result.id, offset: offsetFromTop };
        }
      }
    }
    // Fallback: return first result at offset 0
    return state.results[0] ? { id: state.results[0].id, offset: 0 } : null;
  }, [state.results]);

  // --- Helper: Find cached results across all books in bookCacheRef ---

  const findCachedResults = useCallback(
    (field: SearchField, query: string): CachedFieldResults | null => {
      if (!bookCacheRef) return null;

      for (const [, bookState] of bookCacheRef.current) {
        const cached = bookState.resultsCacheByField[field];
        if (cached?.queryText === query) {
          return cached;
        }
      }
      return null;
    },
    [bookCacheRef]
  );

  // --- Search Handler ---

  const handleSearch = useCallback(
    async (overrideField?: SearchField, overrideQuery?: string, overrideHcId?: number | null, forceSearch?: boolean, skipHistoryUpdate?: boolean) => {
      // Use ref to access current state without stale closure issues
      const currentState = stateRef.current;
      const field = overrideField ?? currentState.searchField;
      const query = overrideQuery ?? currentState.queryTextByField[field];

      if (!query.trim()) return;

      // Check cross-book cache first (multi-book mode optimization)
      // Skip cache if forceSearch is true (user explicitly clicked search button or hit Enter)
      if (!forceSearch) {
        const crossBookCached = findCachedResults(field, query);
        if (crossBookCached) {
          flashSearchingState();
          updateState((prev) => ({
            ...prev,
            results: crossBookCached.results,
            totalResults: crossBookCached.totalResults,
            hasSearched: true,
            resultsCacheByField: {
              ...prev.resultsCacheByField,
              [field]: {
                results: crossBookCached.results,
                totalResults: crossBookCached.totalResults,
                scrollResultId: null,
                scrollResultOffset: 0,
                queryText: query,
              },
            },
          }));
          return;
        }
      }

      // Set searching state (keep old results for overlay spinner)
      updateState((prev) => ({
        ...prev,
        isSearching: true,
        searchError: null,
      }));

      try {
        const searchParams: ShelfmarkSearchParams = {
          query,
          media_type: 'ebook',
        };

        // Add field-specific parameters
        if (field === 'author') searchParams.author = query;
        if (field === 'title') searchParams.title = query;
        if (field === 'series') searchParams.series = query;
        if (field === 'isbn') searchParams.isbn = query;

        // Add HC IDs only when query matches original name (avoids wrong ID for co-authors etc)
        // Backend will upgrade by DB lookup if the name exists in our DB
        if (authorHardcoverId && field === 'author' && authorName && query.trim() === authorName.trim()) {
          searchParams.author_hardcover_id = authorHardcoverId;
        }
        // For series: use override ID (from clicking series link in results), else original if query matches
        if (field === 'series') {
          if (overrideHcId) {
            searchParams.series_hardcover_id = overrideHcId;
          } else if (seriesHardcoverId && seriesName && query.trim() === seriesName.trim()) {
            searchParams.series_hardcover_id = seriesHardcoverId;
          }
        }

        const response = await searchMutation.mutateAsync(searchParams);

        if (response.error && response.results.length === 0) {
          updateState((prev) => ({
            ...prev,
            searchError: response.error,
            results: [],
            totalResults: 0,
            hasSearched: true,
            isSearching: false,
          }));
        } else {
          const sanitized = sanitizeResults(response.results);
          preloadFirstCovers(sanitized, 20);

          updateState((prev) => {
            // Skip history update if called from history navigation (re-fetching invalidated cache)
            if (skipHistoryUpdate) {
              return {
                ...prev,
                results: sanitized,
                totalResults: response.total_results,
                hasSearched: true,
                isSearching: false,
                searchError: response.error || null,
                searchField: field,
                queryTextByField: { ...prev.queryTextByField, [field]: query },
                resultsCacheByField: {
                  ...prev.resultsCacheByField,
                  [field]: {
                    results: sanitized,
                    totalResults: response.total_results,
                    scrollResultId: null,
                    scrollResultOffset: 0,
                    queryText: query,
                  },
                },
              };
            }
            
            // Add to history stack on successful search (with duplicate check)
            let newStack = prev.historyStack.slice(0, prev.historyIndex + 1);
            
            // If stack is empty, add current state as starting point first
            if (newStack.length === 0 && prev.results.length > 0) {
              newStack.push({ field: prev.searchField, queryTextByField: { ...prev.queryTextByField } });
            }
            
            // Check for duplicate before adding new entry
            const newQueryTextByField = { ...prev.queryTextByField, [field]: query };
            const lastEntry = newStack[newStack.length - 1];
            const isDuplicate = lastEntry && 
              lastEntry.field === field && 
              lastEntry.queryTextByField[field] === query;
            
            if (!isDuplicate && query.trim()) {
              newStack.push({ field, queryTextByField: newQueryTextByField });
            }
            
            return {
              ...prev,
              results: sanitized,
              totalResults: response.total_results,
              hasSearched: true,
              isSearching: false,
              searchError: response.error || null,
              searchField: field,
              queryTextByField: newQueryTextByField,
              resultsCacheByField: {
                ...prev.resultsCacheByField,
                [field]: {
                  results: sanitized,
                  totalResults: response.total_results,
                  scrollResultId: null,
                  scrollResultOffset: 0,
                  queryText: query,
                },
              },
              historyStack: newStack,
              historyIndex: newStack.length - 1,
            };
          });

          // Clear enrichment for new search
          clearEnrichment();
        }
      } catch (err) {
        updateState((prev) => ({
          ...prev,
          searchError: err instanceof Error ? err.message : 'Search failed',
          results: [],
          totalResults: 0,
          hasSearched: true,
          isSearching: false,
        }));
      }
    },
    [authorHardcoverId, authorName, seriesHardcoverId, seriesName, findCachedResults, searchMutation, updateState, clearEnrichment, flashSearchingState]
  );

  // --- Helper: Save current results to cache before switching fields ---

  const saveCurrentResultsToCache = useCallback(
    (targetField: SearchField, newQueryTextByField: Record<SearchField, string>) => {
      const currentState = stateRef.current;
      if (currentState.results.length > 0) {
        const scrollInfo = getFirstVisibleResultId();
        const currentQuery = currentState.queryTextByField[currentState.searchField];
        updateState((prev) => {
          // Save current field's results to cache
          const updatedCache = {
            ...prev.resultsCacheByField,
            [prev.searchField]: {
              results: prev.results,
              totalResults: prev.totalResults,
              scrollResultId: scrollInfo?.id ?? null,
              scrollResultOffset: scrollInfo?.offset ?? 0,
              queryText: currentQuery,
            },
          };
          
          // History management:
          // - Truncate any forward history if we went back then navigated again
          // - If stack is empty, add current field first (starting point with current queryTextByField)
          // - Then add the target field with new queryTextByField snapshot
          // - BUT skip if duplicate of last entry (same field + same active query)
          let newStack = prev.historyStack.slice(0, prev.historyIndex + 1);
          if (newStack.length === 0) {
            // First navigation - add the starting point
            newStack.push({ field: prev.searchField, queryTextByField: { ...prev.queryTextByField } });
          }
          
          // Check for duplicate before adding
          const targetQuery = newQueryTextByField[targetField];
          const lastEntry = newStack[newStack.length - 1];
          const isDuplicate = lastEntry && 
            lastEntry.field === targetField && 
            lastEntry.queryTextByField[targetField] === targetQuery;
          
          if (!isDuplicate) {
            newStack.push({ field: targetField, queryTextByField: { ...newQueryTextByField } });
          }
          
          return {
            ...prev,
            resultsCacheByField: updatedCache,
            historyStack: newStack,
            historyIndex: newStack.length - 1,
          };
        });
      }
    },
    [getFirstVisibleResultId, updateState]
  );

  // --- History Navigation ---

  // Can go back if we're not at the first entry (index > 0)
  const canGoBack = state.historyStack.length > 1 && state.historyIndex > 0;
  // Can go forward if we're not at the last entry
  const canGoForward = state.historyIndex < state.historyStack.length - 1;

  // Shared navigation logic for back/forward
  // scrollInfo is the current scroll position to save before navigating (null if no results)
  const navigateHistory = useCallback((direction: -1 | 1, scrollInfo: { id: string; offset: number } | null) => {
    updateState((prev) => {
      const targetIndex = prev.historyIndex + direction;
      const entry = prev.historyStack[targetIndex];
      if (!entry) return prev;
      
      // First, save current scroll position to cache (if we have scroll info to save)
      let updatedCache = prev.resultsCacheByField;
      if (scrollInfo && prev.resultsCacheByField[prev.searchField]) {
        const currentQuery = prev.queryTextByField[prev.searchField];
        updatedCache = {
          ...prev.resultsCacheByField,
          [prev.searchField]: {
            results: prev.resultsCacheByField[prev.searchField]!.results,
            totalResults: prev.resultsCacheByField[prev.searchField]!.totalResults,
            scrollResultId: scrollInfo.id,
            scrollResultOffset: scrollInfo.offset,
            queryText: currentQuery,
          },
        };
      }
      
      const { field: targetField, queryTextByField: snapshotQueryText } = entry;
      const targetQuery = snapshotQueryText[targetField];
      const cached = updatedCache[targetField];
      
      // If cache exists and matches the history entry's queryText, restore results
      if (cached && cached.queryText === targetQuery) {
        return {
          ...prev,
          resultsCacheByField: updatedCache,
          searchField: targetField,
          queryTextByField: { ...snapshotQueryText },  // Restore ALL field values
          results: cached.results,
          totalResults: cached.totalResults,
          view: 'search',
          selectedBook: null,
          historyIndex: targetIndex,
        };
      }

      // No cache or cache was invalidated - will need to search
      // Return state with updated field/query, handleSearch will be triggered separately
      return {
        ...prev,
        resultsCacheByField: updatedCache,
        searchField: targetField,
        queryTextByField: { ...snapshotQueryText },  // Restore ALL field values
        results: [],
        totalResults: 0,
        hasSearched: false,
        view: 'search',
        selectedBook: null,
        historyIndex: targetIndex,
      };
    });
  }, [updateState]);

  const handleHistoryBack = useCallback(() => {
    const targetIndex = state.historyIndex - 1;
    const entry = state.historyStack[targetIndex];
    if (!entry) return;
    
    // Get current scroll position to save
    const scrollInfo = state.results.length > 0 ? getFirstVisibleResultId() : null;
    
    const targetQuery = entry.queryTextByField[entry.field];
    const cached = state.resultsCacheByField[entry.field];
    const needsSearch = !cached || cached.queryText !== targetQuery;
    
    navigateHistory(-1, scrollInfo);
    
    // If cache was invalidated, trigger a fresh search (skip history update to preserve forward stack)
    if (needsSearch && targetQuery.trim()) {
      queueMicrotask(() => handleSearch(entry.field, targetQuery, undefined, undefined, true));
    }
  }, [state.historyIndex, state.historyStack, state.resultsCacheByField, state.results, navigateHistory, handleSearch, getFirstVisibleResultId]);

  const handleHistoryForward = useCallback(() => {
    const targetIndex = state.historyIndex + 1;
    const entry = state.historyStack[targetIndex];
    if (!entry) return;
    
    // Get current scroll position to save
    const scrollInfo = state.results.length > 0 ? getFirstVisibleResultId() : null;
    
    const targetQuery = entry.queryTextByField[entry.field];
    const cached = state.resultsCacheByField[entry.field];
    const needsSearch = !cached || cached.queryText !== targetQuery;
    
    navigateHistory(1, scrollInfo);
    
    // If cache was invalidated, trigger a fresh search (skip history update to preserve stack)
    if (needsSearch && targetQuery.trim()) {
      queueMicrotask(() => handleSearch(entry.field, targetQuery, undefined, undefined, true));
    }
  }, [state.historyIndex, state.historyStack, state.resultsCacheByField, state.results, navigateHistory, handleSearch, getFirstVisibleResultId]);

  // --- Field Change Handler (dropdown switch with cache/history) ---

  const handleFieldChange = useCallback(
    (field: SearchField) => {
      const currentState = stateRef.current;
      if (currentState.searchField === field) return; // No change
      
      const currentQuery = currentState.queryTextByField[currentState.searchField];
      const targetInputQuery = currentState.queryTextByField[field];
      
      // Save current results to cache before switching fields
      if (currentState.results.length > 0) {
        const scrollInfo = getFirstVisibleResultId();
        
        // Check cache for new field
        const cached = currentState.resultsCacheByField[field];
        
        // Lazy invalidation: if cache exists but queryText doesn't match current input,
        // the cache is stale (cross-pollination changed the input). Trigger search instead.
        // Edge case: if user manually edits a cross-pollinated field without searching,
        // then switches back, the old cache may serve until they explicitly search.
        // This is acceptable UX — the input shows the edited value, making it clear.
        if (cached && cached.queryText === targetInputQuery) {
          // Cache hit — restore results (no flash needed, UI change is obvious)
          updateState((prev) => {
            const updatedCache = {
              ...prev.resultsCacheByField,
              [prev.searchField]: {
                results: prev.results,
                totalResults: prev.totalResults,
                scrollResultId: scrollInfo?.id ?? null,
                scrollResultOffset: scrollInfo?.offset ?? 0,
                queryText: currentQuery,
              },
            };
            // Add to history stack with full queryTextByField snapshot
            let newStack = prev.historyStack.slice(0, prev.historyIndex + 1);
            if (newStack.length === 0 && currentQuery.trim()) {
              newStack.push({ field: prev.searchField, queryTextByField: { ...prev.queryTextByField } });
            }
            
            // Check for duplicate before adding
            const lastEntry = newStack[newStack.length - 1];
            const isDuplicate = lastEntry && 
              lastEntry.field === field && 
              lastEntry.queryTextByField[field] === targetInputQuery;
            
            if (!isDuplicate && cached.queryText.trim()) {
              newStack.push({ field, queryTextByField: { ...prev.queryTextByField } });
            }
            return {
              ...prev,
              searchField: field,
              results: cached.results,
              totalResults: cached.totalResults,
              resultsCacheByField: updatedCache,
              historyStack: newStack,
              historyIndex: newStack.length - 1,
            };
          });
        } else {
          // Cache miss or stale — save current cache and switch field
          const isStale = cached && cached.queryText !== targetInputQuery;
          updateState((prev) => {
            const updatedCache = {
              ...prev.resultsCacheByField,
              [prev.searchField]: {
                results: prev.results,
                totalResults: prev.totalResults,
                scrollResultId: scrollInfo?.id ?? null,
                scrollResultOffset: scrollInfo?.offset ?? 0,
                queryText: currentQuery,
              },
            };
            return {
              ...prev,
              searchField: field,
              resultsCacheByField: updatedCache,
            };
          });
          // Only auto-search if cache was stale (cross-pollination changed input)
          // Don't auto-search on null cache (user may want to edit query first)
          if (isStale && targetInputQuery.trim()) {
            queueMicrotask(() => handleSearch(field, targetInputQuery));
          }
        }
      } else {
        // No results to cache, check if we can restore from cache
        const cached = currentState.resultsCacheByField[field];
        
        // Lazy invalidation check
        if (cached && cached.queryText === targetInputQuery) {
          // Cache hit — restore results (no flash needed, UI change is obvious)
          updateState((prev) => {
            // Add to history stack with full queryTextByField snapshot
            let newStack = prev.historyStack.slice(0, prev.historyIndex + 1);
            
            // Check for duplicate before adding
            const lastEntry = newStack[newStack.length - 1];
            const isDuplicate = lastEntry && 
              lastEntry.field === field && 
              lastEntry.queryTextByField[field] === targetInputQuery;
            
            if (!isDuplicate && cached.queryText.trim()) {
              newStack.push({ field, queryTextByField: { ...prev.queryTextByField } });
            }
            return {
              ...prev,
              searchField: field,
              results: cached.results,
              totalResults: cached.totalResults,
              historyStack: newStack,
              historyIndex: newStack.length - 1,
            };
          });
        } else {
          // Cache miss or stale — switch field
          const isStale = cached && cached.queryText !== targetInputQuery;
          setField(field);
          // Only auto-search if cache was stale (cross-pollination changed input)
          // Don't auto-search on null cache (user may want to edit query first)
          if (isStale && targetInputQuery.trim()) {
            queueMicrotask(() => handleSearch(field, targetInputQuery));
          }
        }
      }
    },
    [getFirstVisibleResultId, updateState, setField, handleSearch]
  );

  // --- Field Click Handlers ---

  // Generic handler for clicking on a searchable field (title, author, series)
  // crossPollinate: other fields to update when switching (e.g., clicking author also sets title)
  // hcId: optional Hardcover ID for series lookup
  const handleFieldClick = useCallback(
    (
      targetField: SearchField,
      queryValue: string,
      crossPollinate: Partial<Record<SearchField, string | null>>,
      hcId?: number | null
    ) => {
      const currentState = stateRef.current;

      // If already showing this search, flash spinner and stay
      if (
        currentState.searchField === targetField &&
        currentState.queryTextByField[targetField] === queryValue
      ) {
        flashSearchingState();
        if (currentState.view !== 'search') {
          updateState((prev) => ({ ...prev, view: 'search', selectedBook: null }));
        }
        return;
      }

      // Build updated query text with cross-pollination
      const updatedQueryText = { ...currentState.queryTextByField, [targetField]: queryValue };
      for (const [field, value] of Object.entries(crossPollinate)) {
        if (value) {
          updatedQueryText[field as SearchField] = value;
        }
      }

      // Check if cached results exist for this query
      const cached = currentState.resultsCacheByField[targetField];
      if (cached?.queryText === queryValue) {
        flashSearchingState();
        saveCurrentResultsToCache(targetField, updatedQueryText);
        updateState((prev) => ({
          ...prev,
          searchField: targetField,
          queryTextByField: updatedQueryText,
          results: cached.results,
          totalResults: cached.totalResults,
          view: 'search',
          selectedBook: null,
        }));
        return;
      }

      // Save current results to cache before switching fields
      saveCurrentResultsToCache(targetField, updatedQueryText);

      // Update state and trigger search
      updateState((prev) => ({
        ...prev,
        searchField: targetField,
        queryTextByField: updatedQueryText,
        filterText: '',
        view: 'search',
        selectedBook: null,
      }));

      clearEnrichment();
      queueMicrotask(() => handleSearch(targetField, queryValue, hcId));
    },
    [saveCurrentResultsToCache, updateState, clearEnrichment, handleSearch, flashSearchingState]
  );

  const handleTitleClick = useCallback(
    (title: string, author: string | null, series: string | null) => {
      handleFieldClick('title', title, { author, series });
    },
    [handleFieldClick]
  );

  const handleAuthorClick = useCallback(
    (author: string, title: string | null, series: string | null) => {
      handleFieldClick('author', author, { title, series });
    },
    [handleFieldClick]
  );

  const handleSeriesClick = useCallback(
    (seriesName: string, author: string | null, seriesId: string | null) => {
      // Parse series ID for HC ID-based lookup
      const hcId = seriesId ? parseInt(seriesId, 10) : null;
      handleFieldClick('series', seriesName, { author }, hcId && !isNaN(hcId) ? hcId : null);
    },
    [handleFieldClick]
  );

  // --- Info View Handlers ---

  const handleInfoClick = useCallback(
    (result: ShelfmarkSearchResult) => {
      // Save scroll position before switching to info view
      if (state.results.length > 0) {
        const scrollInfo = getFirstVisibleResultId();
        const currentField = state.searchField;
        const currentQuery = state.queryTextByField[currentField];
        updateState((prev) => ({
          ...prev,
          resultsCacheByField: {
            ...prev.resultsCacheByField,
            [currentField]: {
              results: prev.results,
              totalResults: prev.totalResults,
              scrollResultId: scrollInfo?.id ?? null,
              scrollResultOffset: scrollInfo?.offset ?? 0,
              queryText: currentQuery,
            },
          },
          selectedBook: result,
          view: 'info',
        }));
      } else {
        updateState((prev) => ({
          ...prev,
          selectedBook: result,
          view: 'info',
        }));
      }
    },
    [updateState, state.results, state.searchField, state.queryTextByField, getFirstVisibleResultId]
  );

  const handleBackToSearch = useCallback(() => {
    updateState((prev) => ({
      ...prev,
      view: 'search',
      selectedBook: null,
    }));
  }, [updateState]);

  return {
    state,
    setField,
    setQuery,
    setManualQuery,
    setFilterText,
    setSortBy,
    setSelectedBook,
    setView,
    setState,
    handleSearch,
    handleFieldChange,
    handleTitleClick,
    handleAuthorClick,
    handleSeriesClick,
    handleInfoClick,
    handleBackToSearch,
    canGoBack,
    canGoForward,
    handleHistoryBack,
    handleHistoryForward,
    getFirstVisibleResultId,
    enrichedBooks,
    enrichmentStatus,
    handleRowVisible,
    clearEnrichment,
    ownershipFilter,
    setOwnershipFilter,
  };
}
