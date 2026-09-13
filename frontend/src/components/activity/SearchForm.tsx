/**
 * SearchForm - Search input with field dropdown and manual search toggle
 * Used by both ActivityPage and ActivityOverlay
 */

import React from 'react';
import type { SearchField } from '../../types/activity';
import type { HistoryEntry } from '../../hooks/useActivitySearch';

const SEARCH_FIELDS: { value: SearchField; label: string }[] = [
  { value: 'general', label: 'General' },
  { value: 'author', label: 'Author' },
  { value: 'title', label: 'Title' },
  { value: 'series', label: 'Series' },
  { value: 'isbn', label: 'ISBN' },
];

interface SearchFormProps {
  searchField: SearchField;
  queryText: string;
  manualQuery: boolean;
  isSearching: boolean;
  shelfmarkUrl?: string | null;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onFieldChange: (field: SearchField) => void;
  onQueryChange: (query: string) => void;
  onManualQueryChange: (manual: boolean) => void;
  onSearch: () => void;
  onHistoryBack?: () => void;
  onHistoryForward?: () => void;
  // Debug props (optional)
  debug?: {
    queryTextByField: Record<SearchField, string>;
    historyStack: HistoryEntry[];
    historyIndex: number;
  };
}

export default function SearchForm({
  searchField,
  queryText,
  manualQuery,
  isSearching,
  shelfmarkUrl,
  canGoBack = false,
  canGoForward = false,
  onFieldChange,
  onQueryChange,
  onManualQueryChange,
  onSearch,
  onHistoryBack,
  onHistoryForward,
  debug,
}: SearchFormProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [showSearchMenu, setShowSearchMenu] = React.useState(false);
  const [showDebug, setShowDebug] = React.useState(false);

  // Close menu when clicking outside
  React.useEffect(() => {
    if (!showSearchMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-search-menu]')) {
        setShowSearchMenu(false);
      }
    };
    // Delay to avoid immediate close from the opening click
    setTimeout(() => {
      document.addEventListener('click', handleClickOutside);
    }, 0);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [showSearchMenu]);

  // Handle form submit
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (queryText.trim()) {
      onSearch();
    }
  };

  // Handle keyboard shortcuts
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (queryText.trim()) {
        onSearch();
      }
    }
  };

  // Open in Shelfmark handler
  const handleOpenInShelfmark = () => {
    if (shelfmarkUrl) {
      const smUrl = shelfmarkUrl.replace(/\/$/, '');
      const searchUrl = `${smUrl}/search?q=${encodeURIComponent(queryText)}`;
      window.open(searchUrl, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <form onSubmit={handleSubmit} className="rounded-xl border border-slate-700 bg-slate-800 p-4">
      {/* Search field dropdown + input row */}
      <div className="flex gap-2">
        {/* Back/Forward + Field dropdown + Search input combined */}
        <div className="flex flex-1 rounded-lg border border-slate-600 bg-slate-800">
          <button
            type="button"
            onClick={onHistoryBack}
            disabled={!canGoBack || isSearching}
            className="px-2 py-2 text-slate-400 hover:bg-slate-700 hover:text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors rounded-l-lg"
            title="Back to previous search"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <button
            type="button"
            onClick={onHistoryForward}
            disabled={!canGoForward || isSearching}
            className="px-2 py-2 text-slate-400 hover:bg-slate-700 hover:text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors border-r border-slate-600"
            title="Forward to next search"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
          {/* Field dropdown with spacing container */}
          <div className="flex items-center border-r border-slate-600 pr-3">
            <select
              value={searchField}
              onChange={(e) => onFieldChange(e.target.value as SearchField)}
              disabled={isSearching}
              className="bg-transparent pl-3 pr-1 py-2 text-sm text-slate-200 focus:outline-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
            {SEARCH_FIELDS.map((f) => (
              <option key={f.value} value={f.value} className="bg-slate-800">
                {f.label}
              </option>
            ))}
            </select>
          </div>
          {/* Search input */}
          <input
            ref={inputRef}
            type="text"
            value={queryText}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              searchField === 'general' 
                ? 'Search across supported fields...' 
                : `Search by ${SEARCH_FIELDS.find(f => f.value === searchField)?.label ?? searchField}...`
            }
            className="flex-1 bg-transparent px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none"
            disabled={isSearching}
          />
          {/* Manual query toggle inline */}
          <div 
            className="flex items-center gap-1.5 px-3 border-l border-slate-600 select-none"
            title="Skip metadata lookup - use your search query directly when finding releases"
          >
            <button
              type="button"
              aria-pressed={manualQuery}
              aria-label="Manual query"
              disabled={isSearching}
              onClick={() => onManualQueryChange(!manualQuery)}
              className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded-[4px] border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                manualQuery
                  ? 'border-emerald-500 bg-emerald-600 text-white'
                  : 'border-slate-500 bg-slate-800/70 text-transparent hover:border-slate-300 hover:bg-slate-700'
              }`}
            >
              <svg className="h-2.5 w-2.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.25">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.25 8.25 6.5 11.5 12.75 4.75" />
              </svg>
            </button>
            <span className="text-xs text-slate-400 whitespace-nowrap cursor-pointer" onClick={() => !isSearching && onManualQueryChange(!manualQuery)}>Manual query</span>
          </div>
        </div>

        {/* Search button with dropdown */}
        <div className="relative" data-search-menu>
          <div className="flex">
            <button
              type="submit"
              disabled={!queryText.trim() || isSearching}
              className="rounded-l-lg bg-emerald-600 p-2.5 text-white hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              title="Search"
            >
              {isSearching ? (
                <svg className="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : (
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              )}
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setShowSearchMenu(!showSearchMenu);
              }}
              disabled={isSearching}
              className="rounded-r-lg border-l border-emerald-700 bg-emerald-600 px-1.5 py-2 text-white hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          </div>
          {showSearchMenu && (
            <div className="absolute right-0 top-full mt-1 z-50 min-w-[180px] rounded-lg border border-slate-600 bg-slate-800 py-1 shadow-lg">
              {shelfmarkUrl && (
                <button
                  type="button"
                  onClick={() => {
                    handleOpenInShelfmark();
                    setShowSearchMenu(false);
                  }}
                  className="w-full px-4 py-2 text-left text-sm text-slate-200 hover:bg-slate-700"
                >
                  Open in Shelfmark
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Debug panel (collapsible) */}
      {debug && (
        <div className="mt-3 border-t border-slate-700 pt-3">
          <button
            type="button"
            onClick={() => setShowDebug(!showDebug)}
            className="text-xs text-slate-500 hover:text-slate-300"
          >
            {showDebug ? '▼' : '▶'} Debug
          </button>
          {showDebug && (
            <div className="mt-2 text-xs font-mono text-slate-400 space-y-2">
              {/* Current state */}
              <div>
                <div className="text-slate-500 mb-1">Current State (field: {searchField}):</div>
                <div className="bg-slate-900 rounded p-2 space-y-0.5">
                  {SEARCH_FIELDS.map(f => (
                    <div key={f.value} className={f.value === searchField ? 'text-emerald-400' : ''}>
                      {f.value}: "{debug.queryTextByField[f.value]}"
                      {f.value === searchField && ' ◀'}
                    </div>
                  ))}
                </div>
              </div>

              {/* History stack */}
              <div>
                <div className="text-slate-500 mb-1">
                  History Stack (index: {debug.historyIndex}, len: {debug.historyStack.length}):
                </div>
                <div className="bg-slate-900 rounded p-2 space-y-1 max-h-40 overflow-y-auto">
                  {debug.historyStack.length === 0 ? (
                    <div className="text-slate-600">(empty)</div>
                  ) : (
                    debug.historyStack.map((entry, i) => (
                      <div 
                        key={i} 
                        className={`${i === debug.historyIndex ? 'text-emerald-400 bg-slate-800 -mx-1 px-1 rounded' : ''}`}
                      >
                        [{i}] {entry.field}: "{entry.queryTextByField[entry.field]}"
                        {i === debug.historyIndex && ' ◀ current'}
                        {i === debug.historyIndex - 1 && canGoBack && ' (← back)'}
                        {i === debug.historyIndex + 1 && canGoForward && ' (→ fwd)'}
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* What back/forward would do */}
              {(canGoBack || canGoForward) && (
                <div>
                  <div className="text-slate-500 mb-1">Navigation Preview:</div>
                  <div className="bg-slate-900 rounded p-2 space-y-1">
                    {canGoBack && debug.historyStack[debug.historyIndex - 1] && (
                      <div>
                        ← Back: {debug.historyStack[debug.historyIndex - 1].field} = "
                        {debug.historyStack[debug.historyIndex - 1].queryTextByField[debug.historyStack[debug.historyIndex - 1].field]}"
                      </div>
                    )}
                    {canGoForward && debug.historyStack[debug.historyIndex + 1] && (
                      <div>
                        → Fwd: {debug.historyStack[debug.historyIndex + 1].field} = "
                        {debug.historyStack[debug.historyIndex + 1].queryTextByField[debug.historyStack[debug.historyIndex + 1].field]}"
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </form>
  );
}
