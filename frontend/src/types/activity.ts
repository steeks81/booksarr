/**
 * Shared types for Activity components (ActivityOverlay, ActivityPage)
 * 
 * These types are used by shared components and both views.
 * Replaces the types that were in activityStore.ts.
 */

export type SearchField = 'general' | 'author' | 'title' | 'series' | 'isbn';
export type ViewState = 'search' | 'info' | 'releases';
export type SortBy = 'relevance' | 'series' | 'title' | 'year';
export type OwnershipFilter = 'all' | 'missing' | 'owned';

export interface SeriesInfo {
  series_id: string | null;
  series_name: string | null;
  series_position: number | null;
  series_count: number | null;
  isbn: string | null;
}

export interface CachedResults {
  results: import('../api/shelfmark').ShelfmarkSearchResult[];
  totalResults: number;
  timestamp: number;
  scrollResultId?: string | null;
}

export interface SearchParams {
  field: SearchField;
  query: string;
  manualQuery: boolean;
}

// LocalStorage keys for persisted preferences
export const LS_SORT_BY = 'booksarr-activity-sortBy';
export const LS_OWNERSHIP_FILTER = 'booksarr-activity-ownershipFilter';

// Read persisted sortBy preference
export function getPersistedSortBy(): SortBy {
  try {
    const saved = localStorage.getItem(LS_SORT_BY);
    if (saved && ['relevance', 'series', 'title', 'year'].includes(saved)) {
      return saved as SortBy;
    }
  } catch {}
  return 'relevance';
}

// Read persisted ownershipFilter preference
export function getPersistedOwnershipFilter(): OwnershipFilter {
  try {
    const saved = localStorage.getItem(LS_OWNERSHIP_FILTER);
    if (saved && ['all', 'missing', 'owned'].includes(saved)) {
      return saved as OwnershipFilter;
    }
  } catch {}
  return 'all';
}

// Persist sortBy preference
export function persistSortBy(sortBy: SortBy): void {
  try {
    localStorage.setItem(LS_SORT_BY, sortBy);
  } catch {}
}

// Persist ownershipFilter preference
export function persistOwnershipFilter(filter: OwnershipFilter): void {
  try {
    localStorage.setItem(LS_OWNERSHIP_FILTER, filter);
  } catch {}
}
