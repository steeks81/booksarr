import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import {
  useShelfmarkSearch,
  useShelfmarkReleases,
  useShelfmarkDownload,
  useShelfmarkStatus,
  useShelfmarkCancel,
  useShelfmarkRetry,
  useShelfmarkDismiss,
  startEnrichSeries,
  getEnrichSeriesStatus,
  type ShelfmarkSearchResult,
  type ShelfmarkBookInfo,
  type ShelfmarkRelease,
} from "../api/shelfmark";
import { useSettings } from "../api/settings";
import { useProviderMatch, type ProviderMatchEntry } from "../api/books";

// --- Image preloader with parallel limit ---
// Preloads images in batches to avoid overwhelming the browser/network
const imagePreloadQueue: string[] = [];
const preloadedImages = new Set<string>();
const preloadingImages = new Set<string>();
const imageLoadCallbacks = new Map<string, Array<() => void>>();
const IMAGE_PARALLEL_LIMIT = 6;

function processImageQueue() {
  while (preloadingImages.size < IMAGE_PARALLEL_LIMIT && imagePreloadQueue.length > 0) {
    const url = imagePreloadQueue.shift()!;
    if (preloadedImages.has(url) || preloadingImages.has(url)) continue;
    
    preloadingImages.add(url);
    const img = new Image();
    img.onload = img.onerror = () => {
      preloadingImages.delete(url);
      preloadedImages.add(url);
      // Notify any waiting components
      const callbacks = imageLoadCallbacks.get(url);
      if (callbacks) {
        callbacks.forEach(cb => cb());
        imageLoadCallbacks.delete(url);
      }
      processImageQueue(); // Process next in queue
    };
    img.src = url;
  }
}

function queueImagePreload(url: string, priority: boolean = false, onLoad?: () => void) {
  if (!url) return;
  
  // If already loaded, call callback immediately
  if (preloadedImages.has(url)) {
    onLoad?.();
    return;
  }
  
  // Register callback
  if (onLoad) {
    const callbacks = imageLoadCallbacks.get(url) || [];
    callbacks.push(onLoad);
    imageLoadCallbacks.set(url, callbacks);
  }
  
  // Already queued or loading
  if (preloadingImages.has(url) || imagePreloadQueue.includes(url)) return;
  
  if (priority) {
    imagePreloadQueue.unshift(url); // Add to front for priority
  } else {
    imagePreloadQueue.push(url);
  }
  processImageQueue();
}

// Check if an image is already preloaded
function isImagePreloaded(url: string): boolean {
  return preloadedImages.has(url);
}

// Preload first N cover images from results (call when results arrive)
function preloadFirstCovers(results: Array<{ cover_url?: string | null }>, count: number = 20) {
  for (let i = 0; i < Math.min(count, results.length); i++) {
    const url = results[i].cover_url;
    if (url) queueImagePreload(url, true); // Priority for first batch
  }
}

// Strip HTML tags and convert paragraph breaks to newlines
function stripHtml(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<\/p>\s*<p>/gi, "\n\n")  // Convert </p><p> to double newline
    .replace(/<br\s*\/?>/gi, "\n")      // Convert <br> to newline
    .replace(/<[^>]+>/g, "")            // Strip remaining HTML tags
    .trim();
}

// Normalize ISBN: strip hyphens and spaces, lowercase
function normalizeIsbn(isbn: string): string {
  return isbn.replace(/[-\s]/g, "").toLowerCase();
}

// Source display names (matching SM)
const SOURCE_DISPLAY_NAMES: Record<string, string> = {
  direct_download: "Direct Download",
  prowlarr: "Prowlarr",
  irc: "IRC",
  usenet: "Usenet",
  torrent: "Torrent",
};

function getSourceDisplayName(source: string): string {
  return SOURCE_DISPLAY_NAMES[source] || source.charAt(0).toUpperCase() + source.slice(1).replace(/_/g, " ");
}

// Language badge colors
function getLanguageBadgeColor(lang: string | null): string {
  if (!lang) return "bg-slate-600";
  const l = lang.toLowerCase();
  if (l === "en" || l === "english") return "bg-emerald-600";
  if (l === "es" || l === "spanish") return "bg-amber-600";
  if (l === "de" || l === "german") return "bg-rose-600";
  if (l === "fr" || l === "french") return "bg-blue-600";
  return "bg-slate-600";
}

// Format badge colors
function getFormatBadgeColor(format: string | null): string {
  if (!format) return "bg-slate-600";
  const f = format.toLowerCase();
  if (f === "epub") return "bg-emerald-600";
  if (f === "pdf") return "bg-rose-600";
  if (f === "mobi" || f === "azw3") return "bg-amber-600";
  if (f === "cbz" || f === "cbr") return "bg-purple-600";
  return "bg-slate-600";
}

// Format download progress like SM: "9.4MB / 37.7 MB"
function formatDownloadProgress(progress: number, sizeRaw?: string | null): string {
  if (sizeRaw) {
    const sizeValue = parseFloat(sizeRaw.replace(/[^\d.]/g, ""));
    const sizeUnit = sizeRaw.replace(/[\d.\s]/g, "");
    if (sizeValue > 0) {
      const downloaded = (progress / 100) * sizeValue;
      return `${downloaded.toFixed(1)}${sizeUnit} / ${sizeRaw}`;
    }
  }
  return `${Math.round(progress)}%`;
}

// Title case status for display (SM returns lowercase)
function formatStatus(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

// Status colors matching SM's scheme
type DownloadStatus = "queued" | "pending" | "resolving" | "locating" | "downloading" | "complete" | "error" | "cancelled";

function getStatusTextColor(status: string): string {
  const s = status as DownloadStatus;
  switch (s) {
    case "queued":
    case "pending":
      return "text-amber-300";
    case "resolving":
      return "text-indigo-300";
    case "locating":
      return "text-teal-300";
    case "downloading":
      return "text-sky-300";
    case "complete":
      return "text-green-300";
    case "error":
      return "text-red-300";
    case "cancelled":
      return "text-gray-400";
    default:
      return "text-slate-300";
  }
}

function getStatusBarColor(status: string): string {
  const s = status as DownloadStatus;
  switch (s) {
    case "queued":
    case "pending":
      return "bg-amber-600";
    case "resolving":
      return "bg-indigo-600";
    case "locating":
      return "bg-teal-600";
    case "downloading":
      return "bg-sky-600";
    case "complete":
      return "bg-green-600";
    case "error":
      return "bg-red-600";
    case "cancelled":
      return "bg-gray-500";
    default:
      return "bg-slate-500";
  }
}

// Progress bar percentage matching SM's scheme
function getStatusProgress(status: string, progress: number): number {
  const s = status as DownloadStatus;
  switch (s) {
    case "queued":
    case "pending":
      return 5;
    case "resolving":
      return 15;
    case "locating":
      return 90;
    case "downloading": {
      // SM formula: 20 + (progress * 0.8), clamped to 0-100
      const clamped = Math.max(0, Math.min(100, progress));
      return Math.min(100, 20 + clamped * 0.8);
    }
    case "complete":
    case "error":
    case "cancelled":
      return 100;
    default:
      return 0;
  }
}

// Props for memoized search result row
interface SearchResultRowProps {
  result: ShelfmarkSearchResult;
  index: number;
  coverUrl: string | null;  // Pre-computed: getOwnedCover(result) || result.cover_url
  isOwned: boolean;
  isInCatalogMissing: boolean;
  isEnriched: boolean;
  enrichedData?: { series_name: string | null; series_position: number | null; series_count: number | null; isbn: string | null; enriched_at: number } | null;
  dbIsbn?: string | null;  // ISBN from our local DB (via provider-match)
  dbSeriesData?: { series_name: string | null; series_position: number | null; series_count: number | null } | null;  // Series from our DB
  onVisible?: (result: ShelfmarkSearchResult) => void;  // Called when row becomes visible
  onResultClick: (result: ShelfmarkSearchResult) => void;
  onTitleClick: (title: string, author: string | null, seriesName: string | null) => void;
  onAuthorClick: (author: string, title: string, seriesName: string | null) => void;
  onSeriesClick: (seriesName: string, author: string | null, seriesId: string | null) => void;
  onInfoClick: (result: ShelfmarkSearchResult) => void;
}

// Memoized row component to prevent re-renders when other rows change
// Custom comparison: only re-render if data props change (ignore function props)
const SearchResultRow = React.memo(function SearchResultRow({
  result,
  index,
  coverUrl,
  isOwned,
  isInCatalogMissing,
  isEnriched,
  enrichedData,
  dbIsbn,
  dbSeriesData,
  onVisible,
  onResultClick,
  onTitleClick,
  onAuthorClick,
  onSeriesClick,
  onInfoClick,
}: SearchResultRowProps) {
  const rowRef = React.useRef<HTMLDivElement>(null);
  const [imageReady, setImageReady] = React.useState(() => coverUrl ? isImagePreloaded(coverUrl) : false);
  
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
      className={`flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-slate-800/60 ${index > 0 ? "border-t border-slate-700" : ""}`}
    >
      {/* Cover with position badge above (like SeriesGroup) and owned tick inside */}
      <div className="relative shrink-0">
        {/* Series position badge - above image (like SeriesGroup) */}
        {result.series_position != null && (
          <div className="absolute -top-2 -left-1.5 z-10 flex h-4 min-w-4 items-center justify-center rounded-full bg-slate-700 border border-slate-600 px-1 text-[9px] font-bold text-slate-300">
            {result.series_position}
          </div>
        )}
        <button
          type="button"
          onClick={() => onResultClick(result)}
          className="relative"
        >
          {coverUrl && imageReady ? (
            <img
              src={coverUrl}
              alt=""
              className="h-16 w-12 rounded border border-slate-600 object-cover bg-slate-800"
              onError={(e) => {
                e.currentTarget.style.display = "none";
                e.currentTarget.nextElementSibling?.classList.remove("hidden");
              }}
            />
          ) : null}
          <div className={`flex h-16 w-12 items-center justify-center rounded border border-slate-600 bg-slate-800 text-[10px] text-slate-500 ${coverUrl && imageReady ? "hidden" : ""}`}>
            {coverUrl && !imageReady ? "..." : "No cover"}
          </div>
          {/* Owned checkmark - inside image top right (like BookCard) */}
          {isOwned && (
            <div className="absolute top-0.5 right-0.5 rounded-full bg-emerald-500 p-0.5" title="Owned">
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
            <div className="absolute top-0.5 right-0.5 rounded-full bg-amber-500 p-0.5" title="In catalog (watching)">
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="white">
                <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>
              </svg>
            </div>
          )}
        </button>
      </div>

      {/* Main content - clickable to go to releases */}
      <button
        type="button"
        onClick={() => onResultClick(result)}
        className="min-w-0 flex-1 text-left"
      >
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
              const hasSeries = enrichedData.series_position != null || enrichedData.series_name;
              const hasIsbnOnly = !hasSeries && enrichedData.isbn;
              const isRecent = Date.now() - enrichedData.enriched_at < 30000; // 30 seconds
              const colorClass = hasSeries 
                ? (isRecent ? "text-emerald-400" : "text-emerald-600") 
                : hasIsbnOnly 
                  ? (isRecent ? "text-blue-400" : "text-blue-600") 
                  : "text-slate-400";
              const label = hasSeries ? "series" : hasIsbnOnly ? "ISBN only" : "no data";
              const timeAgo = Math.round((Date.now() - enrichedData.enriched_at) / 1000);
              return (
                <span 
                  className={`ml-2 px-1 ${colorClass} text-xs font-bold cursor-help hover:bg-slate-700 rounded`}
                  title={`Enriched (${label}) ${timeAgo}s ago: ${[
                    enrichedData.series_name ? `series="${enrichedData.series_name}"` : null,
                    enrichedData.series_position != null ? `pos=${enrichedData.series_position}` : null,
                    enrichedData.series_count ? `count=${enrichedData.series_count}` : null,
                    enrichedData.isbn ? `isbn=${enrichedData.isbn}` : null,
                  ].filter(Boolean).join(", ") || "no data"}`}
                >E</span>
              );
            })()
          ) : result.series_position !== null ? (
            <span className="ml-2 px-1 text-amber-400 text-xs font-bold cursor-help hover:bg-slate-700 rounded" title="Already has series_position from search">E</span>
          ) : dbIsbn ? (
            <span className="ml-2 px-1 text-cyan-400 text-xs font-bold cursor-help hover:bg-slate-700 rounded" title={`Has ISBN from DB: ${dbIsbn}`}>E</span>
          ) : !result.series_name ? (
            <span className="ml-2 px-1 text-slate-500 text-xs font-bold cursor-help hover:bg-slate-700 rounded" title="No series hint - ISBN fetched on-demand">E</span>
          ) : null}
        </button>
        {(result.author || result.series_name || enrichedData?.series_name || dbSeriesData?.series_name) && (
          <div className="mt-0.5 truncate text-xs text-slate-400">
            {result.author && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onAuthorClick(result.author!, result.title, result.series_name || enrichedData?.series_name || dbSeriesData?.series_name || null);
                }}
                className="hover:text-emerald-300 hover:underline"
              >
                {result.author}
              </button>
            )}
            {result.author && (result.series_name || enrichedData?.series_name || dbSeriesData?.series_name) && " · "}
            {(result.series_name || enrichedData?.series_name || dbSeriesData?.series_name) && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  const seriesName = result.series_name || enrichedData?.series_name || dbSeriesData?.series_name;
                  onSeriesClick(seriesName!, result.author, result.series_id);
                }}
                className="text-emerald-400 hover:text-emerald-300 hover:underline"
              >
                {(() => {
                  // Prefer result data, then enriched data, then DB data
                  const seriesPos = result.series_position ?? enrichedData?.series_position ?? dbSeriesData?.series_position;
                  const seriesCount = result.series_count ?? enrichedData?.series_count ?? dbSeriesData?.series_count;
                  const seriesName = result.series_name ?? enrichedData?.series_name ?? dbSeriesData?.series_name;
                  if (seriesPos != null) {
                    return `#${seriesPos}${seriesCount ? ` of ${seriesCount}` : ""} in ${seriesName}`;
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
            <span className="font-mono text-slate-400">
              ISBN: {result.isbn || dbIsbn}
            </span>
          )}
          {result.display_fields?.map((field, idx) => (
            <span key={idx} className="flex items-center gap-0.5">
              {field.icon === "star" && <span className="text-amber-400">★</span>}
              {field.icon === "users" && <span>👥</span>}
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
          className="rounded-full p-1.5 text-slate-400 hover:bg-slate-700 hover:text-slate-200 transition-colors"
          title="View details"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M12 20a8 8 0 100-16 8 8 0 000 16z" />
          </svg>
        </button>
        {/* Arrow indicator - clickable to go to releases */}
        <button
          type="button"
          onClick={() => onResultClick(result)}
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
}, (prevProps, nextProps) => {
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
    prevProps.isEnriched === nextProps.isEnriched
  );
});

// Sanitize search result strings - trim whitespace from text fields
// Also adds _key for stable React keys (handles potential duplicate provider:id)
let resultKeyCounter = 0;
function sanitizeResults(results: ShelfmarkSearchResult[]): (ShelfmarkSearchResult & { _key: string })[] {
  return results.map(r => ({
    ...r,
    title: r.title?.trim() || r.title,
    author: r.author?.trim() || r.author,
    series_name: r.series_name?.trim() || r.series_name,
    _key: `${r.provider}:${r.id}:${++resultKeyCounter}`,
  }));
}

export type BulkBook = {
  id: number;
  title: string;
  authorName: string | null;
};

export default function ShelfmarkSearchDialog({
  bookId,
  title,
  authorName,
  authorId,
  authorHardcoverId,
  seriesHardcoverId,
  series,
  authorSearch,
  bulkBooks,
  open,
  onClose,
}: {
  bookId: number | null;
  title: string;
  authorName: string | null;
  authorId: number | null;
  // Hardcover ids (from our DB). When known, search by id for the clean by-id
  // catalog path (avoids the keyword-search 250 cap). Optional - falls back to
  // name-based search when absent.
  authorHardcoverId?: number | null;
  seriesHardcoverId?: number | null;
  series?: string | null;
  authorSearch?: string | null;
  // Multi-book mode: list of books to navigate through with < > arrows
  bulkBooks?: BulkBook[];
  open: boolean;
  onClose: () => void;
}) {
  const { data: settings } = useSettings();
  const { data: providerMatchData } = useProviderMatch(authorId, open); // Fetch provider match data
  const searchMutation = useShelfmarkSearch();
  const releasesMutation = useShelfmarkReleases();
  const downloadMutation = useShelfmarkDownload();
  const cancelMutation = useShelfmarkCancel();
  const retryMutation = useShelfmarkRetry();
  const dismissMutation = useShelfmarkDismiss();
  
  // Multi-book navigation state
  const isBulkMode = bulkBooks && bulkBooks.length > 0;
  const [bulkIndex, setBulkIndex] = useState(0);
  const currentBulkBook = isBulkMode ? bulkBooks[bulkIndex] : null;
  
  // Per-book cache for bulk mode - stores full state per book
  const bulkCacheRef = useRef<Record<number, {
    searchField: "general" | "author" | "title" | "series" | "isbn";
    queryTextByField: Record<string, string>;
    results: (ShelfmarkSearchResult & { _key: string })[];
    resultsCache: Record<string, {
      results: (ShelfmarkSearchResult & { _key: string })[];
      firstVisibleId: string | null;
      firstVisibleOffset: number;
      queryText: string;
    }>;
    view: "search" | "info" | "releases";
    selectedBook: ShelfmarkSearchResult | null;
    bookInfo: ShelfmarkBookInfo | null;
    releases: ShelfmarkRelease[];
    sources: string[];
    activeSource: string | null;
    hasSearched: boolean;
    lastSearchByField: Record<string, { query: string; seriesId?: string | null; authorId?: number | null }>;
    filterText: string;
    // Scroll position for main results list
    firstVisibleId: string | null;
    firstVisibleOffset: number;
  }>>({});
  
  // Flag to trigger auto-search after bulk navigation to uncached book
  const pendingBulkSearchRef = useRef(false);
  
  // Shared cache for author/series searches across books in bulk mode
  // Key format: "author:name:hcId" or "series:name:hcId" or "author:name" etc
  const sharedSearchCacheRef = useRef<Record<string, {
    results: (ShelfmarkSearchResult & { _key: string })[];
    shelfmarkUrl: string | null;
    error: string | null;
  }>>({})
  
  // Poll for download status when in releases view
  const [pollStatus, setPollStatus] = useState(false);
  const { data: statusData } = useShelfmarkStatus(pollStatus, 2000);

  // Search state - separate query text per search field (like SM does)
  const [searchField, setSearchField] = useState<"general" | "author" | "title" | "series" | "isbn">("general");
  const [queryTextByField, setQueryTextByField] = useState<Record<string, string>>({
    general: "",
    author: "",
    title: "",
    series: "",
  });
  const queryText = queryTextByField[searchField] || "";
  const setQueryText = (text: string) => {
    setQueryTextByField(prev => ({ ...prev, [searchField]: text }));
  };
  const [results, setResults] = useState<(ShelfmarkSearchResult & { _key: string })[]>([]);
  
  // Per-type results cache - preserved when switching types, cleared on new search
  const resultsCacheRef = React.useRef<Record<string, {
    results: (ShelfmarkSearchResult & { _key: string })[];
    firstVisibleId: string | null;
    firstVisibleOffset: number;  // How far down from container top the row was
    queryText: string;
  }>>({});
  
  // Helper to get memory usage for debug logging (Chrome only)
  const getHeapMB = () => {
    const mem = (performance as any).memory;
    return mem ? (mem.usedJSHeapSize / 1024 / 1024).toFixed(1) : '?';
  };
  
  // Helper to find the first visible result ID in the scroll container
  const getFirstVisibleResultId = (): { id: string; offset: number } | null => {
    if (!resultsListRef.current || results.length === 0) return null;
    const container = resultsListRef.current;
    const containerRect = container.getBoundingClientRect();
    
    // Find the first result row that's visible in the viewport
    for (const result of results) {
      const el = document.getElementById(`result-row-${result.id}`);
      if (el) {
        const elRect = el.getBoundingClientRect();
        const offsetFromTop = elRect.top - containerRect.top;
        
        // Row is visible if its top is within the container viewport
        if (offsetFromTop >= -50 && offsetFromTop < containerRect.height) {
          console.log(`[getFirstVisible] Found: result-row-${result.id} at offset=${Math.round(offsetFromTop)}px`);
          return { id: result.id, offset: offsetFromTop };
        }
      }
    }
    
    // Fallback: return first result at offset 0
    return results[0] ? { id: results[0].id, offset: 0 } : null;
  };
  
  // Helper to wait for container scrollHeight to stabilize before executing callback
  const waitForStableHeight = (callback: () => void, maxWait = 500) => {
    let lastHeight = 0;
    let stableCount = 0;
    const start = Date.now();
    
    const check = () => {
      const container = resultsListRef.current;
      if (!container) {
        callback();
        return;
      }
      
      const currentHeight = container.scrollHeight;
      if (currentHeight === lastHeight) {
        stableCount++;
        if (stableCount >= 2) {
          console.log(`[ScrollRestore] Height stable after ${Date.now() - start}ms`);
          callback();
          return;
        }
      } else {
        stableCount = 0;
        lastHeight = currentHeight;
      }
      
      if (Date.now() - start < maxWait) {
        requestAnimationFrame(check);
      } else {
        console.log(`[ScrollRestore] Timeout after ${maxWait}ms, proceeding anyway`);
        callback();
      }
    };
    requestAnimationFrame(check);
  };

  // Helper to restore scroll position by finding a result row element
  const restoreScrollToResultId = (targetId: string, savedOffset: number = 0) => {
    const start = Date.now();
    const maxWait = 1000;
    let lastScrollTarget = -1;
    
    const scrollToElement = () => {
      const element = document.getElementById(`result-row-${targetId}`);
      const container = resultsListRef.current;
      if (!element || !container) {
        if (Date.now() - start < maxWait) {
          requestAnimationFrame(scrollToElement);
        } else {
          console.log(`[ScrollRestore] FAILED: result-row-${targetId} not found`);
        }
        return;
      }
      
      const elementRect = element.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const currentOffset = elementRect.top - containerRect.top;
      const scrollTarget = container.scrollTop + currentOffset - savedOffset;
      
      // Only scroll if target changed (avoid infinite loop)
      if (Math.abs(scrollTarget - lastScrollTarget) > 5) {
        lastScrollTarget = scrollTarget;
        container.scrollTop = scrollTarget;
        
        // Check again next frame in case render shifted things
        if (Date.now() - start < maxWait) {
          requestAnimationFrame(scrollToElement);
        } else {
          console.log(`[ScrollRestore] Done after ${Date.now() - start}ms: result-row-${targetId} (scrollTarget=${Math.round(scrollTarget)})`);
        }
      } else {
        console.log(`[ScrollRestore] Stable after ${Date.now() - start}ms: result-row-${targetId} (scrollTarget=${Math.round(scrollTarget)})`);
      }
    };
    
    // Start immediately
    requestAnimationFrame(scrollToElement);
  };
  
  // Cleanup on unmount (browser back, navigation, etc.)
  useEffect(() => {
    return () => {
      const cacheSize = Object.keys(resultsCacheRef.current).length;
      if (cacheSize > 0) {
        console.log(`[ResultsCache] Cleared ALL (unmount) - had ${cacheSize} types cached (heap: ${getHeapMB()}MB)`);
      }
      resultsCacheRef.current = {};
    };
  }, []);
  
  const [shelfmarkUrl, setShelfmarkUrl] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  
  // Persisted preferences (localStorage)
  const [sortBy, setSortBy] = useState<"relevance" | "series" | "title" | "year">(() => {
    const saved = localStorage.getItem("shelfmark-sortBy");
    return (saved as "relevance" | "series" | "title" | "year") || "relevance";
  });
  const [includeOwned, setIncludeOwned] = useState(() => {
    const saved = localStorage.getItem("shelfmark-includeOwned");
    return saved === "true";
  });
  
  // Track last executed search per type to avoid redundant requests
  // Includes IDs so clicking different series/authors with same name triggers new search
  const [lastSearchByField, setLastSearchByField] = useState<Record<string, { query: string; seriesId?: string | null; authorId?: number | null }>>({});

  // Releases view state
  const [view, setView] = useState<"search" | "info" | "releases">("search");
  const [selectedBook, setSelectedBook] = useState<ShelfmarkSearchResult | null>(null);
  const [bookInfo, setBookInfo] = useState<ShelfmarkBookInfo | null>(null);
  const [releases, setReleases] = useState<ShelfmarkRelease[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [activeSource, setActiveSource] = useState<string | null>(null);
  const [releasesError, setReleasesError] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadSuccess, setDownloadSuccess] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  
  // Scroll position preservation for search results
  const resultsListRef = React.useRef<HTMLDivElement>(null);
  const savedScrollPosition = React.useRef<number>(0);
  const shouldRestoreScroll = React.useRef<boolean>(false);
  
  // Helper to wait for container scrollHeight to stabilize
  const waitForStableHeightThenScroll = (scrollPos: number) => {
    let lastHeight = 0;
    let stableCount = 0;
    const start = Date.now();
    const maxWait = 1000;
    
    const check = () => {
      const container = resultsListRef.current;
      if (!container) return;
      
      if (container.scrollHeight === lastHeight && lastHeight > 0) {
        stableCount++;
        if (stableCount >= 3) {  // Stable for 3 frames
          container.scrollTop = scrollPos;
          console.log(`[ScrollRestore] View stable: scrolling to ${scrollPos}, actual=${container.scrollTop}`);
          return;
        }
      } else {
        stableCount = 0;
        lastHeight = container.scrollHeight;
      }
      
      if (Date.now() - start < maxWait) {
        requestAnimationFrame(check);
      } else {
        container.scrollTop = scrollPos;
        console.log(`[ScrollRestore] View timeout, scrolling to ${scrollPos}, actual=${container.scrollTop}`);
      }
    };
    requestAnimationFrame(check);
  };
  
  // Mark that we should restore scroll when returning to search view (from info/releases)
  useEffect(() => {
    if (view === "search" && shouldRestoreScroll.current) {
      shouldRestoreScroll.current = false;
      if (savedScrollPosition.current > 0) {
        waitForStableHeightThenScroll(savedScrollPosition.current);
      }
    }
  }, [view]);
  
  // Track which releases have been initiated/completed/cancelled
  // seenInProgressIds tracks IDs that have actually appeared in SM's in_progress list
  // This prevents marking as complete before SM has even started processing
  const [initiatedIds, setInitiatedIds] = useState<Set<string>>(new Set());
  const [seenInProgressIds, setSeenInProgressIds] = useState<Set<string>>(new Set());
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());
  const [cancelledIds, setCancelledIds] = useState<Set<string>>(new Set());
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  
  // Description expand state
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  
  // Manual query option - bypasses SM's metadata lookup for release search
  const [manualQuery, setManualQuery] = useState(false);
  
  // Client-side text filter for results
  const [filterText, setFilterText] = useState("");
  
  // Persist sortBy and includeOwned to localStorage
  useEffect(() => {
    localStorage.setItem("shelfmark-sortBy", sortBy);
  }, [sortBy]);
  
  useEffect(() => {
    localStorage.setItem("shelfmark-includeOwned", String(includeOwned));
  }, [includeOwned]);
  
  // Series enrichment progress tracking
  const [seriesEnrichProgress, setSeriesEnrichProgress] = useState<{ current: number; total: number } | null>(null);
  const [seriesEnrichError, setSeriesEnrichError] = useState<string | null>(null);
  // Books this search needs enriched (drives per-search polling). null = not enriching.
  const [enrichBooks, setEnrichBooks] = useState<Array<{ provider: string; book_id: string }> | null>(null);
  const enrichPollRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const lastEnrichUpdateRef = React.useRef<number>(0);  // Batch UI updates during enrichment
  
  // Series cache: provider:bookId -> series info (cleared on dialog close)
  const [seriesCache, setSeriesCache] = useState<Map<string, {
    series_id: string | null;
    series_name: string | null;
    series_position: number | null;
    series_count: number | null;
    isbn: string | null;
    enriched_at: number; // timestamp in ms
  }>>(new Map());
  
  // Get matched book from our DB via provider-match API
  const getMatchedBook = (result: ShelfmarkSearchResult): ProviderMatchEntry | null => {
    if (!providerMatchData) return null;
    
    // Match by provider-specific ID
    if (result.provider === "hardcover" && result.id) {
      const match = providerMatchData.by_hardcover_id[result.id];
      if (match) return match;
    }
    if (result.provider === "googlebooks" && result.id) {
      const match = providerMatchData.by_google_id[result.id];
      if (match) return match;
    }
    
    // Fallback: match by ISBN
    if (result.isbn) {
      const normalizedIsbn = normalizeIsbn(result.isbn);
      const match = providerMatchData.by_isbn[normalizedIsbn];
      if (match) return match;
    }
    
    return null;
  };
  
  // Check if a search result is owned (simple yes/no, for filtering)
  const isOwned = (result: ShelfmarkSearchResult): boolean => {
    const matched = getMatchedBook(result);
    return matched?.is_owned ?? false;
  };
  
  // Check if a search result is in our catalog but missing the file
  const isInCatalogMissing = (result: ShelfmarkSearchResult): boolean => {
    const matched = getMatchedBook(result);
    return matched !== null && !matched.is_owned;
  };
  
  // Sorted and filtered results based on filterText, sortBy, and includeOwned
  const sortedResults = useMemo(() => {
    let filtered = results;
    
    // Apply text filter (matches title, series, or author - case insensitive)
    if (filterText.trim()) {
      const searchLower = filterText.toLowerCase().trim();
      filtered = filtered.filter(r => 
        (r.title?.toLowerCase().includes(searchLower)) ||
        (r.series_name?.toLowerCase().includes(searchLower)) ||
        (r.author?.toLowerCase().includes(searchLower))
      );
    }
    
    // Filter out owned books unless includeOwned is checked
    if (!includeOwned) {
      filtered = filtered.filter(r => !isOwned(r));
    }
    
    // Then sort
    if (sortBy === "relevance") return filtered;
    return [...filtered].sort((a, b) => {
      // Helper for series comparison (empty series sorts last)
      const compareSeries = (x: ShelfmarkSearchResult, y: ShelfmarkSearchResult) => {
        const seriesX = x.series_name?.trim() || "\uffff";
        const seriesY = y.series_name?.trim() || "\uffff";
        if (seriesX !== seriesY) return seriesX.localeCompare(seriesY);
        return (x.series_position ?? 999) - (y.series_position ?? 999);
      };
      
      switch (sortBy) {
        case "series":
          // series_name → series_position
          return compareSeries(a, b);
        case "title": {
          // title → series_name → series_position
          const titleCmp = (a.title || "").localeCompare(b.title || "");
          if (titleCmp !== 0) return titleCmp;
          return compareSeries(a, b);
        }
        case "year": {
          // year (newest first) → series_name → series_position → title
          const yearCmp = (b.year ?? 0) - (a.year ?? 0);
          if (yearCmp !== 0) return yearCmp;
          const seriesCmp = compareSeries(a, b);
          if (seriesCmp !== 0) return seriesCmp;
          return (a.title || "").localeCompare(b.title || "");
        }
        default:
          return 0;
      }
    });
  }, [results, filterText, sortBy, includeOwned, providerMatchData]);
  
  // Get owned book cover for a search result (from provider-match data)
  const getOwnedCover = (result: ShelfmarkSearchResult): string | null => {
    const matched = getMatchedBook(result);
    if (matched?.cover_path) {
      return `/api/images/${matched.cover_path.replace("cache/", "")}`;
    }
    return null;
  };
  
  // Format badge styling (matches BookTable.tsx)
  const FORMAT_BADGE_STYLES: Record<string, { label: string; className: string }> = {
    epub: { label: "EPUB", className: "bg-emerald-500/15 text-emerald-300" },
    mobi: { label: "MOBI", className: "bg-blue-500/15 text-blue-300" },
    pdf: { label: "PDF", className: "bg-amber-500/15 text-amber-300" },
    audiobook: { label: "AUDIO", className: "bg-purple-500/15 text-purple-300" },
  };
  
  // Get owned formats for a search result (from provider-match data)
  const getOwnedFormats = (result: ShelfmarkSearchResult): string[] | null => {
    const matched = getMatchedBook(result);
    if (matched && matched.formats.length > 0) {
      return matched.formats;
    }
    return null;
  };
  
  // Update completed status from polling data
  useEffect(() => {
    if (!statusData) return;
    
    const inProgressIds = new Set(statusData.in_progress.map(d => d.source_id));
    
    // Track IDs that have appeared in in_progress (so we know SM started processing)
    setSeenInProgressIds(prev => {
      const newSeen = new Set(prev);
      inProgressIds.forEach(id => newSeen.add(id));
      return newSeen;
    });
    
    // Only mark as complete if:
    // 1. It was initiated by us
    // 2. It has been seen in in_progress at least once (SM actually started it)
    // 3. It's no longer in in_progress
    // 4. It wasn't cancelled
    setCompletedIds(prev => {
      const newCompleted = new Set(prev);
      initiatedIds.forEach(id => {
        if (seenInProgressIds.has(id) && !inProgressIds.has(id) && !prev.has(id) && !cancelledIds.has(id)) {
          newCompleted.add(id);
        }
      });
      return newCompleted;
    });
    
    // Stop polling when:
    // 1. in_progress is empty
    // 2. All initiated downloads have been seen in in_progress (SM processed them)
    // 3. All initiated downloads are either completed or cancelled
    if (statusData.in_progress.length === 0 && pollStatus && initiatedIds.size > 0) {
      const allSeen = Array.from(initiatedIds).every(id => seenInProgressIds.has(id));
      const allDone = Array.from(initiatedIds).every(id => 
        completedIds.has(id) || cancelledIds.has(id)
      );
      if (allSeen && allDone) {
        setPollStatus(false);
      }
    }
  }, [statusData, initiatedIds, seenInProgressIds, completedIds, cancelledIds, pollStatus]);

  // Reset state when dialog opens
  useEffect(() => {
    if (!open) {
      setPollStatus(false);
      // Stop this dialog's enrichment polling (background worker keeps running)
      setEnrichBooks(null);
      // Clear series cache on close
      setSeriesCache(new Map());
      // Clear per-type results cache on close
      const cacheSize = Object.keys(resultsCacheRef.current).length;
      if (cacheSize > 0) {
        console.log(`[ResultsCache] Cleared ALL (dialog close) - had ${cacheSize} types cached (heap: ${getHeapMB()}MB)`);
      }
      resultsCacheRef.current = {};
      // Clear bulk cache on close
      bulkCacheRef.current = {};
      sharedSearchCacheRef.current = {};
      setBulkIndex(0);
      return;
    }
    
    // Determine search field based on props
    let initialField: "general" | "author" | "title" | "series" = "general";
    
    if (authorSearch) {
      initialField = "author";
    } else if (title) {
      // Title takes precedence - if searching for a specific book, use title search
      initialField = "title";
    } else if (series) {
      initialField = "series";
    } else {
      initialField = "general";
    }
    
    setSearchField(initialField);
    // Prefill query texts for all known fields (helps user switch between search types)
    // When opening for series search, also prefill author if known
    // When opening for book (title) search, prefill author and series if known
    // General field: author + series for series search, author + title otherwise
    const generalPrefill = initialField === "series"
      ? [authorSearch || authorName || "", series || ""].filter(Boolean).join(" ").trim()
      : [authorSearch || authorName || "", title].filter(Boolean).join(" ").trim();
    setQueryTextByField({
      general: generalPrefill,
      author: authorSearch || authorName || "",
      title: title || "",
      series: series || "",
    });
    setResults([]);
    setShelfmarkUrl(null);
    setSearchError(null);
    setHasSearched(false);
    setLastSearchByField({});
    setView("search");
    setSelectedBook(null);
    setBookInfo(null);
    setReleases([]);
    setSources([]);
    setActiveSource(null);
    setReleasesError(null);
    setDownloadingId(null);
    setDownloadSuccess(null);
    setDownloadError(null);
    setInitiatedIds(new Set());
    setSeenInProgressIds(new Set());
    setCompletedIds(new Set());
    setCancelledIds(new Set());
    setDescriptionExpanded(false);
    setManualQuery(false);
    setPollStatus(false);
    setSeriesEnrichProgress(null);
    setSeriesEnrichError(null);
    // Don't reset sortBy or includeOwned - they persist via localStorage
    setFilterText("");
    
    // Auto-search when opened with author, series, or title
    if (authorSearch || series || title) {
      const doAutoSearch = async () => {
        try {
          const searchParams: { series?: string; author?: string; title?: string; isbn?: string; query?: string; media_type: "ebook" | "audiobook"; author_hardcover_id?: number | null; series_hardcover_id?: number | null } = {
            media_type: "ebook",
          };
          
          if (initialField === "author") {
            searchParams.author = authorSearch || authorName || "";
            // Prefer id-based search when we know the author's Hardcover id
            if (authorHardcoverId != null) searchParams.author_hardcover_id = authorHardcoverId;
          } else if (initialField === "series") {
            searchParams.series = series || "";
            if (seriesHardcoverId != null) searchParams.series_hardcover_id = seriesHardcoverId;
            // Don't filter by author for series search - series name is specific enough
            // and author filter causes issues with co-authored books
          } else if (initialField === "title") {
            searchParams.title = title || "";
          } else {
            searchParams.query = [authorName ?? "", title].filter(Boolean).join(" ").trim();
          }
          
          const response = await searchMutation.mutateAsync(searchParams);

          if (response.error && response.results.length === 0) {
            // Hard error - no results at all
            setSearchError(response.error);
            setResults([]);
          } else {
            // Success, or soft warning with partial results
            const sanitized = sanitizeResults(response.results);
            preloadFirstCovers(sanitized, 20); // Preload first 20 covers immediately
            
            // Log enrichment stats - note: only books with series_name hint will be enriched
            const alreadyHasSeries = sanitized.filter(r => r.series_position !== null).length;
            const hasSeriesHint = sanitized.filter(r => r.provider && r.series_position === null && r.series_name).length;
            const noSeriesHint = sanitized.filter(r => r.provider && r.series_position === null && !r.series_name).length;
            console.log(`[Search] ${sanitized.length} results: ${alreadyHasSeries} have series (amber), ${hasSeriesHint} will enrich (series hint → green), ${noSeriesHint} skipped (gray/cyan if DB ISBN)`);
            
            setResults(sanitized);
            setShelfmarkUrl(response.shelfmark_url);
            setSearchError(response.error || null);  // Show warning if present
            setLastSearchByField(prev => ({
              ...prev,
              [initialField]: {
                query: searchParams.title || searchParams.author || searchParams.series || searchParams.query || "",
                ...(initialField === "series" && seriesHardcoverId != null ? { seriesId: String(seriesHardcoverId) } : {}),
                ...(initialField === "author" && authorHardcoverId != null ? { authorId: authorHardcoverId } : {}),
              }
            }));
            // Series enrichment will be triggered by a separate useEffect when results change
          }
        } catch (err) {
          setSearchError(err instanceof Error ? err.message : "Search failed");
          setResults([]);
        }
        setHasSearched(true);
      };
      
      doAutoSearch();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Auto-search when bulk navigation moves to a new (uncached) book
  useEffect(() => {
    if (!isBulkMode || !bulkBooks || !open) return;
    if (!pendingBulkSearchRef.current) return;
    
    pendingBulkSearchRef.current = false;
    const book = bulkBooks[bulkIndex];
    
    // Trigger title search for this book
    const doAutoSearch = async () => {
      try {
        const searchParams = {
          title: book.title,
          media_type: "ebook" as const,
        };
        
        const response = await searchMutation.mutateAsync(searchParams);

        if (response.error && response.results.length === 0) {
          setSearchError(response.error);
          setResults([]);
        } else {
          const sanitized = sanitizeResults(response.results);
          preloadFirstCovers(sanitized, 20);
          
          const alreadyHasSeries = sanitized.filter(r => r.series_position !== null).length;
          const hasSeriesHint = sanitized.filter(r => r.provider && r.series_position === null && r.series_name).length;
          const noSeriesHint = sanitized.filter(r => r.provider && r.series_position === null && !r.series_name).length;
          console.log(`[Search] ${sanitized.length} results: ${alreadyHasSeries} have series (amber), ${hasSeriesHint} will enrich (series hint → green), ${noSeriesHint} skipped (gray/cyan if DB ISBN)`);
          
          setResults(sanitized);
          setShelfmarkUrl(response.shelfmark_url);
          setSearchError(response.error || null);
          setLastSearchByField(prev => ({
            ...prev,
            title: { query: book.title },
          }));
        }
      } catch (err) {
        setSearchError(err instanceof Error ? err.message : "Search failed");
        setResults([]);
      }
      setHasSearched(true);
    };
    
    doAutoSearch();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bulkIndex, isBulkMode, open]);

  // Apply cached series data to results when they load (no enrichment queuing here)
  useEffect(() => {
    if (!hasSearched || results.length === 0) return;
    
    // Apply locally-cached series data to results
    const resultsNeedingUpdate: Array<{ id: string; series_id: string | null; series_name: string | null; series_position: number | null; series_count: number | null; isbn: string | null }> = [];
    
    for (const r of results) {
      if (!r.provider || r.series_position !== null) continue;
      
      const cacheKey = `${r.provider}:${r.id}`;
      const cached = seriesCache.get(cacheKey);
      
      if (cached) {
        resultsNeedingUpdate.push({
          id: r.id,
          series_id: cached.series_id,
          series_name: cached.series_name,
          series_position: cached.series_position,
          series_count: cached.series_count,
          isbn: cached.isbn,
        });
      }
    }
    
    if (resultsNeedingUpdate.length > 0) {
      setResults(prev => prev.map(r => {
        const update = resultsNeedingUpdate.find(u => u.id === r.id);
        return update ? { ...r, ...update } : r;
      }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasSearched, results.length]);
  
  // Visibility-based enrichment: queue books as they become visible
  // Called by IntersectionObserver in each SearchResultRow
  const handleRowVisible = useCallback((result: ShelfmarkSearchResult) => {
    // Skip if already has series info, in cache, or no provider
    if (!result.provider || result.series_position !== null) return;
    const cacheKey = `${result.provider}:${result.id}`;
    if (seriesCache.has(cacheKey)) return;
    
    // Skip if no series hint - these books likely won't have series data
    // ISBN will be fetched on-demand when clicking Info/Releases
    if (!result.series_name) return;
    
    // Queue this book for enrichment (prepend for priority)
    setEnrichBooks(prev => {
      if (prev?.some(b => b.book_id === result.id)) return prev; // Already queued
      const newBook = { provider: result.provider!, book_id: result.id };
      const newQueue = prev ? [newBook, ...prev] : [newBook];
      
      // Update progress
      setSeriesEnrichProgress(p => ({
        current: p?.current ?? 0,
        total: newQueue.length,
      }));
      
      // Start enrichment for this book
      startEnrichSeries([newBook]).catch(err => {
        console.error("Series enrichment queue error:", err);
      });
      
      return newQueue;
    });
  }, [seriesCache]);
  
  // Initial enrichment effect removed - now handled by onVisible callback
  
  // Per-search polling: query status for THIS search's books, apply cached series
  // to the table as they land, compute X/Y, stop when all done (or worker idle).
  useEffect(() => {
    if (!enrichBooks || enrichBooks.length === 0) return;
    
    let cancelled = false;
    
    const poll = async () => {
      try {
        const status = await getEnrichSeriesStatus(enrichBooks);
        if (cancelled) return;
        
        // Apply any newly-cached series to the results table + local cache.
        const seriesEntries = Object.entries(status.series);
        if (seriesEntries.length > 0) {
          // Always update cache first (tracks what we've seen from backend)
          const enrichedAt = Date.now();
          setSeriesCache(prev => {
            const next = new Map(prev);
            for (const [bookId, info] of seriesEntries) {
              const book = enrichBooks.find(b => b.book_id === bookId);
              if (book) next.set(`${book.provider}:${bookId}`, { ...info, enriched_at: enrichedAt });
            }
            return next;
          });
          
          // Batch UI updates: only apply to results every 3 seconds
          // Reduces re-renders while enrichment runs. P1-F11-S3 (paging) will fix this properly.
          const now = Date.now();
          if (!lastEnrichUpdateRef.current) lastEnrichUpdateRef.current = 0;
          const shouldUpdate = now - lastEnrichUpdateRef.current > 3000 || status.done >= status.total;
          
          if (shouldUpdate) {
            lastEnrichUpdateRef.current = now;
            setResults(prev => prev.map(r => {
              const info = status.series[r.id];
              if (info && r.series_position === null) {
                return { ...r, ...info };
              }
              return r;
            }));
          }
        }
        
        // Progress = how many of MY books are done.
        setSeriesEnrichProgress({ current: status.done, total: status.total });
        
        // Rate-limit state is global (shared worker) - show it while ours aren't done.
        if (status.rate_limited && status.message) {
          setSeriesEnrichError(status.message);
        } else {
          setSeriesEnrichError(null);
        }
        
        // Done when all my books are cached, OR the worker is idle and can't
        // make more progress on them (e.g. paused on rate limit / genuine misses).
        if (status.done >= status.total || !status.worker_running) {
          if (cancelled) return;
          if (enrichPollRef.current) {
            clearInterval(enrichPollRef.current);
            enrichPollRef.current = null;
          }
          setEnrichBooks(null);
          setSeriesEnrichProgress(null);
          setSeriesEnrichError(null);
        }
      } catch (err) {
        console.error("Series enrichment poll error:", err);
      }
    };
    
    // Poll immediately, then on interval.
    poll();
    enrichPollRef.current = setInterval(poll, 1500);
    
    return () => {
      cancelled = true;
      if (enrichPollRef.current) {
        clearInterval(enrichPollRef.current);
        enrichPollRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enrichBooks]);

  // Note: We no longer fetch book details on info view open.
  // Info view now uses search result data + provider-match (our DB) data.
  // This eliminates the external get_book call that was causing delay.

  if (!open) return null;

  const isConfigured = Boolean(settings?.shelfmark_url && settings?.shelfmark_password_set);

  const handleSearch = async () => {
    if (!queryText.trim()) return;

    const typed = queryText.trim();
    
    // Build shared cache key for author/series searches (these are shareable across books)
    let sharedCacheKey: string | null = null;
    if (isBulkMode && (searchField === "author" || searchField === "series")) {
      const hcId = searchField === "author" 
        ? (authorHardcoverId != null && typed === (authorSearch || authorName || "").trim() ? authorHardcoverId : null)
        : (seriesHardcoverId != null && typed === (series || "").trim() ? seriesHardcoverId : null);
      sharedCacheKey = `${searchField}:${typed}:${hcId ?? ""}`;
      
      // Check shared cache first
      const cached = sharedSearchCacheRef.current[sharedCacheKey];
      if (cached) {
        console.log(`[SharedCache] Hit for '${sharedCacheKey}' (${cached.results.length} results)`);
        setResults(cached.results);
        setShelfmarkUrl(cached.shelfmarkUrl);
        setSearchError(cached.error);
        setHasSearched(true);
        setLastSearchByField(prev => ({ ...prev, [searchField]: { query: typed } }));
        // Clear per-type cache for this type since we're loading from shared
        delete resultsCacheRef.current[searchField];
        return;
      }
    }

    // Clear cached results for this search type (new search invalidates cache)
    if (resultsCacheRef.current[searchField]) {
      console.log(`[ResultsCache] Invalidated '${searchField}' cache (new search) (heap: ${getHeapMB()}MB)`);
    }
    delete resultsCacheRef.current[searchField];

    // Stop this search's enrichment polling; the new search starts its own
    setEnrichBooks(null);
    
    setSearchError(null);
    setHasSearched(false);  // Reset to trigger series enrichment useEffect
    setSeriesEnrichProgress(null);
    setSeriesEnrichError(null);
    
    // Don't reset sortBy - it persists via localStorage
    setFilterText("");

    try {
      const searchParams: { series?: string; author?: string; title?: string; isbn?: string; query?: string; media_type: "ebook" | "audiobook"; author_hardcover_id?: number | null; series_hardcover_id?: number | null } = {
        media_type: "ebook",
      };
      
      // Build search params based on searchField.
      // Only attach a Hardcover id when the typed text still matches the known
      // name for that field - if the user edited it to a different name, the id
      // would be stale, so fall back to name search.
      if (searchField === "author") {
        searchParams.author = typed;
        if (authorHardcoverId != null && typed === (authorSearch || authorName || "").trim()) {
          searchParams.author_hardcover_id = authorHardcoverId;
        }
      } else if (searchField === "series") {
        searchParams.series = typed;
        if (seriesHardcoverId != null && typed === (series || "").trim()) {
          searchParams.series_hardcover_id = seriesHardcoverId;
        }
      } else if (searchField === "title") {
        searchParams.title = typed;
      } else if (searchField === "isbn") {
        searchParams.isbn = typed;
      } else {
        // "general" - use query param
        searchParams.query = typed;
      }
      
      const response = await searchMutation.mutateAsync(searchParams);

      if (response.error && response.results.length === 0) {
        // Hard error - no results at all
        setSearchError(response.error);
        setResults([]);
        setHasSearched(true);
        // Store error in shared cache too
        if (sharedCacheKey) {
          sharedSearchCacheRef.current[sharedCacheKey] = {
            results: [],
            shelfmarkUrl: null,
            error: response.error,
          };
        }
      } else {
        // Success, or soft warning with partial results
        const sanitized = sanitizeResults(response.results);
        preloadFirstCovers(sanitized, 20);
        
        // Log enrichment stats - note: only books with series_name hint will be enriched
        const alreadyHasSeries = sanitized.filter(r => r.series_position !== null).length;
        const hasSeriesHint = sanitized.filter(r => r.provider && r.series_position === null && r.series_name).length;
        const noSeriesHint = sanitized.filter(r => r.provider && r.series_position === null && !r.series_name).length;
        console.log(`[Search] ${sanitized.length} results: ${alreadyHasSeries} have series (amber), ${hasSeriesHint} will enrich (series hint → green), ${noSeriesHint} skipped (gray/cyan if DB ISBN)`);
        
        setResults(sanitized);
        setShelfmarkUrl(response.shelfmark_url);
        setSearchError(response.error || null);  // Show warning if present
        setHasSearched(true);  // This triggers series enrichment useEffect
        setLastSearchByField(prev => ({ ...prev, [searchField]: { query: typed } }));
        
        // Store in shared cache for author/series searches
        if (sharedCacheKey) {
          console.log(`[SharedCache] Stored '${sharedCacheKey}' (${sanitized.length} results)`);
          sharedSearchCacheRef.current[sharedCacheKey] = {
            results: sanitized,
            shelfmarkUrl: response.shelfmark_url,
            error: response.error || null,
          };
        }
      }
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "Search failed");
      setResults([]);
      setHasSearched(true);
    }
  };

  // Handle clicking a series name to search for that series
  // Also prefills author field if author is known
  const handleSeriesClick = async (seriesNameToSearch: string, authorName?: string | null, seriesId?: string | null) => {
    // If already showing this series search, do nothing (or go back if in info/releases view)
    if (searchField === "series" && queryText === seriesNameToSearch) {
      if (view !== "search") handleBackToSearch();
      return;
    }
    
    // Skip search if same as last executed search (including series ID)
    const lastSeriesSearch = lastSearchByField["series"];
    console.log(`[handleSeriesClick] Check skip: lastSeriesSearch=${JSON.stringify(lastSeriesSearch)}, seriesNameToSearch="${seriesNameToSearch}", seriesId="${seriesId}", hasSearched=${hasSearched}`);
    if (lastSeriesSearch?.query === seriesNameToSearch && lastSeriesSearch?.seriesId === seriesId && hasSearched) {
      // Save current results to cache before switching
      if (results.length > 0 && searchField !== "series") {
        const firstVisible = getFirstVisibleResultId();
        resultsCacheRef.current[searchField] = {
          results,
          firstVisibleId: firstVisible?.id || null,
          firstVisibleOffset: firstVisible?.offset || 0,
          queryText: queryText,
        };
        console.log(`[ResultsCache] Saved '${searchField}' (${results.length} results, firstVisible=${firstVisible?.id}) before series skip-search (heap: ${getHeapMB()}MB)`);
      }
      setSearchField("series");
      // Restore cached series results
      const cached = resultsCacheRef.current["series"];
      if (cached) {
        console.log(`[ResultsCache] Restored 'series' (${cached.results.length} results) - skip-search path (heap: ${getHeapMB()}MB)`);
        setResults(cached.results);
        setQueryTextByField(prev => ({ ...prev, series: cached.queryText }));
        setSearchError(null);  // Clear any error from other search type
        shouldRestoreScroll.current = false;  // Prevent view-change scroll restore from interfering
        savedScrollPosition.current = 0;  // Clear stale pixel position
        if (cached.firstVisibleId) {
          restoreScrollToResultId(cached.firstVisibleId, cached.firstVisibleOffset);
        }
      }
      setView("search");
      return;
    }
    
    // Save current results to cache before switching types
    if (results.length > 0) {
      const firstVisible = getFirstVisibleResultId();
      resultsCacheRef.current[searchField] = {
        results,
        firstVisibleId: firstVisible?.id || null,
        firstVisibleOffset: firstVisible?.offset || 0,
        queryText: queryText,
      };
      console.log(`[ResultsCache] Saved '${searchField}' (${results.length} results, firstVisible=${firstVisible?.id}) before series link click (heap: ${getHeapMB()}MB)`);
    }
    
    // Clear cached results for series (new search invalidates cache)
    if (resultsCacheRef.current["series"]) {
      console.log(`[ResultsCache] Invalidated 'series' cache (series link click) (heap: ${getHeapMB()}MB)`);
    }
    delete resultsCacheRef.current["series"];
    
    // Stop this search's enrichment polling; the new search starts its own
    setEnrichBooks(null);
    
    // Clear releases/info state
    setSelectedBook(null);
    setBookInfo(null);
    setReleases([]);
    setSources([]);
    setActiveSource(null);
    setReleasesError(null);
    setDownloadSuccess(null);
    setDownloadError(null);
    
    // Update state to search by series
    // Also prefill author field if known (helps user switch back to author search)
    setSearchField("series");
    setFilterText("");
    setQueryTextByField(prev => ({
      ...prev,
      series: seriesNameToSearch,
      ...(authorName ? { author: authorName } : {}),
    }));
    setSearchError(null);
    setHasSearched(false);
    setSeriesEnrichProgress(null);
    setSeriesEnrichError(null);
    setView("search");
    
    try {
      // Use series_hardcover_id when available for exact by-id search
      const seriesHcId = seriesId ? parseInt(seriesId, 10) : null;
      const response = await searchMutation.mutateAsync({
        series: seriesNameToSearch,
        media_type: "ebook",
        ...(seriesHcId && !isNaN(seriesHcId) ? { series_hardcover_id: seriesHcId } : {}),
      });

      if (response.error && response.results.length === 0) {
        // Hard error - no results at all
        setSearchError(response.error);
        setResults([]);
        setHasSearched(true);
      } else {
        // Success, or soft warning with partial results
        const sanitized = sanitizeResults(response.results);
        preloadFirstCovers(sanitized, 20);
        
        // Log enrichment stats - note: only books with series_name hint will be enriched
        const alreadyHasSeries = sanitized.filter(r => r.series_position !== null).length;
        const hasSeriesHint = sanitized.filter(r => r.provider && r.series_position === null && r.series_name).length;
        const noSeriesHint = sanitized.filter(r => r.provider && r.series_position === null && !r.series_name).length;
        console.log(`[Search] ${sanitized.length} results: ${alreadyHasSeries} have series (amber), ${hasSeriesHint} will enrich (series hint → green), ${noSeriesHint} skipped (gray/cyan if DB ISBN)`);
        
        setResults(sanitized);
        setShelfmarkUrl(response.shelfmark_url);
        setSearchError(response.error || null);  // Show warning if present
        setHasSearched(true);
        setLastSearchByField(prev => ({ ...prev, series: { query: seriesNameToSearch, seriesId: seriesId } }));
      }
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "Search failed");
      setResults([]);
      setHasSearched(true);
    }
  };

  // Handle clicking an author to search for that author
  // Also prefills title and series fields if known
  const handleAuthorClick = async (authorToSearch: string, titleName?: string | null, seriesName?: string | null) => {
    // If already showing this author search, do nothing (or go back if in info/releases view)
    if (searchField === "author" && queryText === authorToSearch) {
      if (view !== "search") handleBackToSearch();
      return;
    }
    
    // Skip search if same as last executed search
    const lastAuthorSearch = lastSearchByField["author"];
    console.log(`[handleAuthorClick] Check skip: lastAuthorSearch=${JSON.stringify(lastAuthorSearch)}, authorToSearch="${authorToSearch}", hasSearched=${hasSearched}`);
    if (lastAuthorSearch?.query === authorToSearch && hasSearched) {
      // Save current results to cache before switching
      if (results.length > 0 && searchField !== "author") {
        const firstVisible = getFirstVisibleResultId();
        resultsCacheRef.current[searchField] = {
          results,
          firstVisibleId: firstVisible?.id || null,
          firstVisibleOffset: firstVisible?.offset || 0,
          queryText: queryText,
        };
        console.log(`[ResultsCache] Saved '${searchField}' (${results.length} results, firstVisible=${firstVisible?.id}) before author skip-search (heap: ${getHeapMB()}MB)`);
      }
      setSearchField("author");
      // Restore cached author results
      const cached = resultsCacheRef.current["author"];
      if (cached) {
        console.log(`[ResultsCache] Restored 'author' (${cached.results.length} results) - skip-search path (heap: ${getHeapMB()}MB)`);
        setResults(cached.results);
        setQueryTextByField(prev => ({ ...prev, author: cached.queryText }));
        setSearchError(null);  // Clear any error from other search type
        shouldRestoreScroll.current = false;  // Prevent view-change scroll restore from interfering
        savedScrollPosition.current = 0;  // Clear stale pixel position
        if (cached.firstVisibleId) {
          restoreScrollToResultId(cached.firstVisibleId, cached.firstVisibleOffset);
        }
      }
      setView("search");
      return;
    }
    
    // Save current results to cache before switching types
    if (results.length > 0) {
      const firstVisible = getFirstVisibleResultId();
      resultsCacheRef.current[searchField] = {
        results,
        firstVisibleId: firstVisible?.id || null,
        firstVisibleOffset: firstVisible?.offset || 0,
        queryText: queryText,
      };
      console.log(`[ResultsCache] Saved '${searchField}' (${results.length} results, firstVisible=${firstVisible?.id}) before author link click (heap: ${getHeapMB()}MB)`);
    }
    
    // Clear cached results for author (new search invalidates cache)
    if (resultsCacheRef.current["author"]) {
      console.log(`[ResultsCache] Invalidated 'author' cache (author link click) (heap: ${getHeapMB()}MB)`);
    }
    delete resultsCacheRef.current["author"];
    
    // Stop this search's enrichment polling; the new search starts its own
    setEnrichBooks(null);
    
    // Clear releases/info state
    setSelectedBook(null);
    setBookInfo(null);
    setReleases([]);
    setSources([]);
    setActiveSource(null);
    setReleasesError(null);
    setDownloadSuccess(null);
    setDownloadError(null);
    
    // Update state to search by author
    // Also prefill title and series fields if known
    setSearchField("author");
    setFilterText("");
    setQueryTextByField(prev => ({
      ...prev,
      author: authorToSearch,
      ...(titleName ? { title: titleName } : {}),
      ...(seriesName ? { series: seriesName } : {}),
    }));
    setSearchError(null);
    setHasSearched(false);
    setSeriesEnrichProgress(null);
    setSeriesEnrichError(null);
    setView("search");
    
    try {
      const response = await searchMutation.mutateAsync({
        author: authorToSearch,
        media_type: "ebook",
      });

      if (response.error && response.results.length === 0) {
        // Hard error - no results at all
        setSearchError(response.error);
        setResults([]);
        setHasSearched(true);
      } else {
        // Success, or soft warning with partial results
        const sanitized = sanitizeResults(response.results);
        preloadFirstCovers(sanitized, 20);
        
        // Log enrichment stats - note: only books with series_name hint will be enriched
        const alreadyHasSeries = sanitized.filter(r => r.series_position !== null).length;
        const hasSeriesHint = sanitized.filter(r => r.provider && r.series_position === null && r.series_name).length;
        const noSeriesHint = sanitized.filter(r => r.provider && r.series_position === null && !r.series_name).length;
        console.log(`[Search] ${sanitized.length} results: ${alreadyHasSeries} have series (amber), ${hasSeriesHint} will enrich (series hint → green), ${noSeriesHint} skipped (gray/cyan if DB ISBN)`);
        
        setResults(sanitized);
        setShelfmarkUrl(response.shelfmark_url);
        setSearchError(response.error || null);  // Show warning if present
        setHasSearched(true);
        setLastSearchByField(prev => ({ ...prev, author: { query: authorToSearch } }));
      }
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "Search failed");
      setResults([]);
      setHasSearched(true);
    }
  };

  // Handle clicking a title to search for that title
  // Also prefills author and series fields if known
  const handleTitleClick = async (titleToSearch: string, authorName?: string | null, seriesName?: string | null) => {
    // If already showing this title search, do nothing (or go back if in info/releases view)
    if (searchField === "title" && queryText === titleToSearch) {
      if (view !== "search") handleBackToSearch();
      return;
    }
    
    // Skip search if same as last executed search
    const lastTitleSearch = lastSearchByField["title"];
    console.log(`[handleTitleClick] Check skip: lastTitleSearch=${JSON.stringify(lastTitleSearch)}, titleToSearch="${titleToSearch}", hasSearched=${hasSearched}`);
    if (lastTitleSearch?.query === titleToSearch && hasSearched) {
      // Save current results to cache before switching
      if (results.length > 0 && searchField !== "title") {
        const firstVisible = getFirstVisibleResultId();
        resultsCacheRef.current[searchField] = {
          results,
          firstVisibleId: firstVisible?.id || null,
          firstVisibleOffset: firstVisible?.offset || 0,
          queryText: queryText,
        };
        console.log(`[ResultsCache] Saved '${searchField}' (${results.length} results, firstVisible=${firstVisible?.id}) before title skip-search (heap: ${getHeapMB()}MB)`);
      }
      setSearchField("title");
      // Restore cached title results
      const cached = resultsCacheRef.current["title"];
      if (cached) {
        console.log(`[ResultsCache] Restored 'title' (${cached.results.length} results) - skip-search path (heap: ${getHeapMB()}MB)`);
        setResults(cached.results);
        setQueryTextByField(prev => ({ ...prev, title: cached.queryText }));
        setSearchError(null);  // Clear any error from other search type
        shouldRestoreScroll.current = false;  // Prevent view-change scroll restore from interfering
        savedScrollPosition.current = 0;  // Clear stale pixel position
        if (cached.firstVisibleId) {
          restoreScrollToResultId(cached.firstVisibleId, cached.firstVisibleOffset);
        }
      }
      setView("search");
      return;
    }
    
    // Save current results to cache before switching types
    if (results.length > 0) {
      const firstVisible = getFirstVisibleResultId();
      resultsCacheRef.current[searchField] = {
        results,
        firstVisibleId: firstVisible?.id || null,
        firstVisibleOffset: firstVisible?.offset || 0,
        queryText: queryText,
      };
      console.log(`[ResultsCache] Saved '${searchField}' (${results.length} results, firstVisible=${firstVisible?.id}) before title link click (heap: ${getHeapMB()}MB)`);
    }
    
    // Clear cached results for title (new search invalidates cache)
    if (resultsCacheRef.current["title"]) {
      console.log(`[ResultsCache] Invalidated 'title' cache (title link click) (heap: ${getHeapMB()}MB)`);
    }
    delete resultsCacheRef.current["title"];
    
    // Stop this search's enrichment polling; the new search starts its own
    setEnrichBooks(null);
    
    // Clear releases/info state
    setSelectedBook(null);
    setBookInfo(null);
    setReleases([]);
    setSources([]);
    setActiveSource(null);
    setReleasesError(null);
    setDownloadSuccess(null);
    setDownloadError(null);
    
    // Update state to search by title
    // Also prefill author and series fields if known
    setSearchField("title");
    setFilterText("");
    setQueryTextByField(prev => ({
      ...prev,
      title: titleToSearch,
      ...(authorName ? { author: authorName } : {}),
      ...(seriesName ? { series: seriesName } : {}),
    }));
    setSearchError(null);
    setHasSearched(false);
    setSeriesEnrichProgress(null);
    setSeriesEnrichError(null);
    setView("search");
    
    try {
      const response = await searchMutation.mutateAsync({
        title: titleToSearch,
        media_type: "ebook",
      });

      if (response.error && response.results.length === 0) {
        // Hard error - no results at all
        setSearchError(response.error);
        setResults([]);
        setHasSearched(true);
      } else {
        // Success, or soft warning with partial results
        const sanitized = sanitizeResults(response.results);
        preloadFirstCovers(sanitized, 20);
        
        // Log enrichment stats - note: only books with series_name hint will be enriched
        const alreadyHasSeries = sanitized.filter(r => r.series_position !== null).length;
        const hasSeriesHint = sanitized.filter(r => r.provider && r.series_position === null && r.series_name).length;
        const noSeriesHint = sanitized.filter(r => r.provider && r.series_position === null && !r.series_name).length;
        console.log(`[Search] ${sanitized.length} results: ${alreadyHasSeries} have series (amber), ${hasSeriesHint} will enrich (series hint → green), ${noSeriesHint} skipped (gray/cyan if DB ISBN)`);
        
        setResults(sanitized);
        setShelfmarkUrl(response.shelfmark_url);
        setSearchError(response.error || null);  // Show warning if present
        setHasSearched(true);
        setLastSearchByField(prev => ({ ...prev, title: { query: titleToSearch } }));
      }
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "Search failed");
      setResults([]);
      setHasSearched(true);
    }
  };

  const handleResultClick = async (result: ShelfmarkSearchResult) => {
    // Save scroll position before navigating away
    if (resultsListRef.current) {
      savedScrollPosition.current = resultsListRef.current.scrollTop;
      shouldRestoreScroll.current = true;
      console.log(`[ScrollRestore] Saved scroll position: ${savedScrollPosition.current} (heap: ${getHeapMB()}MB)`);
    }
    
    // Get the provider and book_id from the result
    // The result.source is the provider (e.g., "Google Books")
    // The result.id is the provider_id
    setSelectedBook(result);
    setView("releases");
    setReleasesError(null);
    setReleases([]);
    setSources([]);
    setActiveSource(null);
    setDownloadSuccess(null);
    setDownloadError(null);

    // Determine provider from source display name
    let provider = "googlebooks"; // default
    const src = (result.source || "").toLowerCase();
    if (src.includes("google")) provider = "googlebooks";
    else if (src.includes("hardcover")) provider = "hardcover";
    else if (src.includes("openlibrary") || src.includes("open library")) provider = "openlibrary";

    // Note: We no longer fetch book details in parallel with releases.
    // Info view uses search result data + provider-match (our DB) data.

    // Build manual query text from search text (what user typed)
    const manualQueryText = queryText.trim();

    try {
      // Build request params
      const requestParams: { provider: string; book_id: string; manual_query?: string } = {
        provider,
        book_id: result.id,
      };
      
      // If manual query is enabled, pass manual_query to override SM's metadata-based search
      if (manualQuery && manualQueryText) {
        requestParams.manual_query = manualQueryText;
      }
      
      let response = await releasesMutation.mutateAsync(requestParams);
      
      // Preserve book info from first response (has correct metadata)
      const firstBookInfo = response.book;

      // Auto-retry with manual_query if no results and manual query not already enabled
      if (!manualQuery && !response.error && response.releases.length === 0 && manualQueryText) {
        // Retry with manual query
        response = await releasesMutation.mutateAsync({
          provider,
          book_id: result.id,
          manual_query: manualQueryText,
        });
      }

      if (response.error) {
        setReleasesError(response.error);
      } else {
        // Use book info from first response (metadata search) if available, 
        // as it has cleaner author data without narrator
        setBookInfo(firstBookInfo || response.book);
        setReleases(response.releases);
        setSources(response.sources);
        // Default to first source tab
        if (response.sources.length > 0) {
          setActiveSource(response.sources[0]);
        }
      }
    } catch (err) {
      setReleasesError(err instanceof Error ? err.message : "Failed to fetch releases");
    }
  };

  const handleBackToSearch = () => {
    setView("search");
    setSelectedBook(null);
    setBookInfo(null);
    setReleases([]);
    setSources([]);
    setActiveSource(null);
    setReleasesError(null);
    setDownloadSuccess(null);
    setDownloadError(null);
  };

  // Bulk navigation handlers
  const handleBulkPrev = () => {
    if (!isBulkMode || bulkIndex === 0) return;
    saveBulkState(bulkIndex);
    const newIndex = bulkIndex - 1;
    setBulkIndex(newIndex);
    restoreBulkState(newIndex);
  };

  const handleBulkNext = () => {
    if (!isBulkMode || !bulkBooks || bulkIndex >= bulkBooks.length - 1) return;
    saveBulkState(bulkIndex);
    const newIndex = bulkIndex + 1;
    setBulkIndex(newIndex);
    restoreBulkState(newIndex);
  };

  // Retry title search for current bulk book
  const handleBulkRetry = async () => {
    if (!isBulkMode || !bulkBooks) return;
    const book = bulkBooks[bulkIndex];
    
    // Clear cached state for this book
    delete bulkCacheRef.current[book.id];
    
    // Reset to search view and trigger new search
    setView("search");
    setSearchField("title");
    setQueryTextByField(prev => ({ ...prev, title: book.title }));
    setResults([]);
    setHasSearched(false);
    setSearchError(null);
    pendingBulkSearchRef.current = true;
  };

  // Save current state to bulk cache
  const saveBulkState = (index: number) => {
    if (!isBulkMode || !bulkBooks) return;
    const bookId = bulkBooks[index].id;
    // Capture current scroll position
    const firstVisible = getFirstVisibleResultId();
    bulkCacheRef.current[bookId] = {
      searchField,
      queryTextByField,
      results,
      resultsCache: { ...resultsCacheRef.current },
      view,
      selectedBook,
      bookInfo,
      releases,
      sources,
      activeSource,
      hasSearched,
      lastSearchByField,
      filterText,
      firstVisibleId: firstVisible?.id || null,
      firstVisibleOffset: firstVisible?.offset || 0,
    };
    console.log(`[BulkCache] Saved book ${bookId} (firstVisible=${firstVisible?.id}, offset=${firstVisible?.offset})`);
  };

  // Restore state from bulk cache, or initialize for new book
  const restoreBulkState = (index: number) => {
    if (!isBulkMode || !bulkBooks) return;
    const book = bulkBooks[index];
    const cached = bulkCacheRef.current[book.id];
    
    if (cached) {
      // Restore from cache
      setSearchField(cached.searchField);
      setQueryTextByField(cached.queryTextByField);
      setResults(cached.results);
      resultsCacheRef.current = { ...cached.resultsCache };
      setView(cached.view);
      setSelectedBook(cached.selectedBook);
      setBookInfo(cached.bookInfo);
      setReleases(cached.releases);
      setSources(cached.sources);
      setActiveSource(cached.activeSource);
      setHasSearched(cached.hasSearched);
      setLastSearchByField(cached.lastSearchByField);
      setFilterText(cached.filterText);
      // Restore scroll position after React renders
      if (cached.firstVisibleId && cached.view === "search") {
        console.log(`[BulkCache] Restoring book ${book.id} scroll to ${cached.firstVisibleId} offset=${cached.firstVisibleOffset}`);
        restoreScrollToResultId(cached.firstVisibleId, cached.firstVisibleOffset);
      }
    } else {
      // Initialize for new book - reset state and trigger search
      setSearchField("title");
      setQueryTextByField({
        general: "",
        author: book.authorName || "",
        title: book.title,
        series: "",
      });
      setResults([]);
      resultsCacheRef.current = {};
      setView("search");
      setSelectedBook(null);
      setBookInfo(null);
      setReleases([]);
      setSources([]);
      setActiveSource(null);
      setReleasesError(null);
      setHasSearched(false);
      setLastSearchByField({});
      setFilterText("");
      setSearchError(null);
      // Mark for auto-search - the useEffect will pick this up
      pendingBulkSearchRef.current = true;
    }
  };

  const handleDownload = async (release: ShelfmarkRelease) => {
    setDownloadingId(release.source_id);
    setDownloadSuccess(null);
    setDownloadError(null);
    
    // Clear any previous cancelled/completed/seen state BEFORE starting download
    setCancelledIds(prev => {
      const newSet = new Set(prev);
      newSet.delete(release.source_id);
      return newSet;
    });
    setCompletedIds(prev => {
      const newSet = new Set(prev);
      newSet.delete(release.source_id);
      return newSet;
    });
    setSeenInProgressIds(prev => {
      const newSet = new Set(prev);
      newSet.delete(release.source_id);
      return newSet;
    });

    try {
      const response = await downloadMutation.mutateAsync({
        source: release.source,
        source_id: release.source_id,
        // Release metadata
        title: release.title,
        author: release.author || undefined,
        format: release.format || undefined,
        size: release.size || undefined,
        cover_url: release.cover_url || undefined,
        // Book metadata - prefer selectedBook (BA metadata) for filesystem consistency
        book_title: selectedBook?.title || bookInfo?.title,
        book_author: selectedBook?.author || bookInfo?.author || undefined,
        book_year: bookInfo?.year || selectedBook?.year || undefined,
        book_provider: bookInfo?.provider || undefined,
        book_provider_id: bookInfo?.provider_id || selectedBook?.id,
        // Series metadata from bookInfo or selectedBook
        series_name: bookInfo?.series_name || selectedBook?.series_name || undefined,
        series_position: bookInfo?.series_position || selectedBook?.series_position || undefined,
      });

      if (response.success) {
        setDownloadSuccess(`Download queued: ${release.title}`);
        // Track this release as initiated
        setInitiatedIds(prev => new Set(prev).add(release.source_id));
        // Start polling for status updates
        setPollStatus(true);
      } else {
        setDownloadError(response.error || "Download failed");
      }
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : "Download failed");
    } finally {
      setDownloadingId(null);
    }
  };

  const handleOpenShelfmarkSearch = () => {
    if (shelfmarkUrl || settings?.shelfmark_url) {
      const smUrl = (shelfmarkUrl || settings?.shelfmark_url || "").replace(/\/$/, "");
      const searchUrl = `${smUrl}/search?q=${encodeURIComponent(queryText)}`;
      window.open(searchUrl, "_blank", "noopener,noreferrer");
    }
  };

  const handleCancelDownload = async (source_id: string) => {
    try {
      await cancelMutation.mutateAsync(source_id);
      // Mark as cancelled so it doesn't show as complete
      setCancelledIds(prev => new Set(prev).add(source_id));
      // Remove from initiated to stop tracking
      setInitiatedIds(prev => {
        const newSet = new Set(prev);
        newSet.delete(source_id);
        return newSet;
      });
    } catch (err) {
      // Ignore cancel errors
    }
  };

  // Filter releases by active source
  const filteredReleases = activeSource
    ? releases.filter((r) => r.source === activeSource)
    : releases;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 px-4 py-6">
      <div className="flex h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl resize">
        {/* Header */}
        <div className="flex shrink-0 items-start justify-between border-b border-slate-700 px-6 py-4">
          <div className="min-w-0 flex-1">
            {view === "search" ? (
              <>
                <h2 className="text-lg font-semibold text-slate-100">
                  Search Shelfmark
                </h2>
                <p className="mt-1 text-sm text-slate-400">
                  Search for books via Shelfmark. Click a result to find available downloads.
                </p>
              </>
            ) : (
              <>
                <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  {view === "info" ? "Book Info" : "Find Releases"}
                </div>
                <button
                  type="button"
                  onClick={() => handleTitleClick(
                    bookInfo?.title || selectedBook?.title || "",
                    bookInfo?.author || selectedBook?.author,
                    bookInfo?.series_name || selectedBook?.series_name
                  )}
                  className="block mt-1 truncate text-lg font-semibold text-slate-100 hover:text-emerald-300 hover:underline text-left"
                >
                  {bookInfo?.title || selectedBook?.title || "Loading..."}
                </button>
                {(selectedBook?.author || bookInfo?.author) && (
                  <button
                    type="button"
                    onClick={() => handleAuthorClick(
                      selectedBook?.author || bookInfo?.author || "",
                      bookInfo?.title || selectedBook?.title,
                      bookInfo?.series_name || selectedBook?.series_name
                    )}
                    className="block mt-0.5 truncate text-sm text-slate-400 hover:text-emerald-300 hover:underline text-left"
                  >
                    {selectedBook?.author || bookInfo?.author}
                  </button>
                )}
              </>
            )}
          </div>
          <div className="ml-4 flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 rounded-md border border-slate-600 bg-slate-800 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-700"
            >
              Close
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {/* Not configured warning */}
          {!isConfigured && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-5">
              <div className="text-base font-semibold text-amber-200">Configure Shelfmark first</div>
              <p className="mt-2 text-sm text-amber-100/90">
                Shelfmark URL and credentials need to be configured before searching.
              </p>
              <div className="mt-3 space-y-1 text-sm text-amber-50/80">
                {!settings?.shelfmark_url && (
                  <div>
                    Shelfmark URL: <span className="text-amber-300">not set</span>
                  </div>
                )}
                {settings?.shelfmark_url && !settings?.shelfmark_password_set && (
                  <div>
                    Credentials: <span className="text-amber-300">not set</span>
                  </div>
                )}
              </div>
              <div className="mt-4 flex items-center gap-3">
                <Link
                  to="/settings/shelfmark"
                  onClick={onClose}
                  className="inline-flex items-center rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500"
                >
                  Open Shelfmark Settings
                </Link>
              </div>
            </div>
          )}

          {/* SEARCH VIEW */}
          {isConfigured && view === "search" && (
            <>
              {/* Search form */}
              <div className="rounded-xl border border-slate-700 bg-slate-800 p-4">
                <div className="mb-2 text-sm font-medium text-slate-200">Search Query</div>
                <div className="flex gap-2">
                  <select
                    value={searchField}
                    onChange={(e) => {
                      const newField = e.target.value as "general" | "author" | "title" | "series" | "isbn";
                      // Save current results and scroll position to cache before switching
                      if (results.length > 0) {
                        const firstVisible = getFirstVisibleResultId();
                        resultsCacheRef.current[searchField] = {
                          results,
                          firstVisibleId: firstVisible?.id || null,
                          firstVisibleOffset: firstVisible?.offset || 0,
                          queryText: queryText,
                        };
                        console.log(`[ResultsCache] Saved '${searchField}' (${results.length} results, firstVisible=${firstVisible?.id}) (heap: ${getHeapMB()}MB)`);
                      }
                      // Switch to new field
                      setSearchField(newField);
                      // Restore cached results for new field (if any)
                      const cached = resultsCacheRef.current[newField];
                      if (cached) {
                        const totalCached = Object.keys(resultsCacheRef.current).length;
                        console.log(`[ResultsCache] Restored '${newField}' (${cached.results.length} results, firstVisible=${cached.firstVisibleId}) - ${totalCached} types cached (heap: ${getHeapMB()}MB)`);
                        setResults(cached.results);
                        setQueryTextByField(prev => ({ ...prev, [newField]: cached.queryText }));
                        setSearchError(null);  // Clear any error from other search type
                        setHasSearched(true);
                        // Restore scroll position by scrolling to first visible result
                        shouldRestoreScroll.current = false;  // Prevent view-change scroll restore from interfering
                        savedScrollPosition.current = 0;  // Clear stale pixel position
                        if (cached.firstVisibleId) {
                          restoreScrollToResultId(cached.firstVisibleId, cached.firstVisibleOffset);
                        }
                      } else {
                        console.log(`[ResultsCache] No cache for '${newField}' - showing empty (heap: ${getHeapMB()}MB)`);
                        setResults([]);
                        setHasSearched(false);
                      }
                    }}
                    className="rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  >
                    <option value="general">General</option>
                    <option value="author">Author</option>
                    <option value="title">Title</option>
                    <option value="series">Series</option>
                    <option value="isbn">ISBN</option>
                  </select>
                  <input
                    value={queryText}
                    onChange={(e) => !isBulkMode && setQueryText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && queryText.trim() && !isBulkMode) {
                        handleSearch();
                      }
                    }}
                    readOnly={isBulkMode}
                    className={`rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-sm text-slate-100 ${isBulkMode ? "flex-1 cursor-default opacity-75" : "flex-1"}`}
                    placeholder={
                      searchField === "author" ? "Author name..." :
                      searchField === "title" ? "Book title..." :
                      searchField === "series" ? "Series name..." :
                      searchField === "isbn" ? "ISBN (10 or 13 digits)..." :
                      "Author Name Book Title"
                    }
                  />
                  {/* Bulk navigation - next to search input */}
                  {isBulkMode && bulkBooks && (
                    <div className="flex items-center gap-1 rounded-lg border border-slate-600 bg-slate-700 px-1">
                      <button
                        type="button"
                        onClick={handleBulkPrev}
                        disabled={bulkIndex === 0 || searchMutation.isPending}
                        className="rounded p-1.5 text-slate-400 hover:bg-slate-600 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
                        title="Previous book"
                      >
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                        </svg>
                      </button>
                      <span className="min-w-[4rem] text-center text-sm text-slate-300">
                        {bulkIndex + 1} of {bulkBooks.length}
                      </span>
                      <button
                        type="button"
                        onClick={handleBulkNext}
                        disabled={bulkIndex === bulkBooks.length - 1 || searchMutation.isPending}
                        className="rounded p-1.5 text-slate-400 hover:bg-slate-600 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
                        title="Next book"
                      >
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </button>
                    </div>
                  )}
                </div>
                <div className="mt-2 flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="manualQuery"
                      checked={manualQuery}
                      onChange={(e) => setManualQuery(e.target.checked)}
                      className="h-4 w-4 rounded border-slate-600 bg-slate-700 text-emerald-600 focus:ring-emerald-500"
                    />
                    <label
                      htmlFor="manualQuery"
                      className="text-xs text-slate-400 cursor-pointer"
                      title="Skip metadata lookup - use your search query directly when finding releases"
                    >
                      Manual query
                    </label>
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={handleSearch}
                    disabled={searchMutation.isPending || !queryText.trim()}
                    className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {searchMutation.isPending ? "Searching..." : "Search"}
                  </button>
                  {(shelfmarkUrl || settings?.shelfmark_url) && (
                    <button
                      type="button"
                      onClick={handleOpenShelfmarkSearch}
                      className="rounded-md border border-slate-600 bg-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-600"
                    >
                      Open in Shelfmark
                    </button>
                  )}
                </div>
              </div>

              {/* Error/warning message */}
              {searchError && (
                <div className={`mt-4 rounded-xl border p-4 ${
                  results.length > 0 
                    ? "border-amber-500/30 bg-amber-500/10" 
                    : "border-rose-500/30 bg-rose-500/10"
                }`}>
                  <div className={`text-sm ${results.length > 0 ? "text-amber-300" : "text-rose-300"}`}>{searchError}</div>
                </div>
              )}

              {/* Loading state */}
              {searchMutation.isPending && (
                <div className="mt-5 flex flex-col items-center justify-center py-12">
                  <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-600 border-t-emerald-500" />
                  <div className="mt-3 text-sm text-slate-400">Searching...</div>
                </div>
              )}

              {/* Results */}
              {hasSearched && !searchMutation.isPending && (searchError ? results.length > 0 : true) && (
                <div className="mt-5 rounded-xl border border-slate-700 bg-slate-800 p-4">
                  <div className="mb-3 flex items-center justify-between">
                    {/* Left: Filter, Sort, Include owned */}
                    <div className="flex items-center gap-3">
                      {results.length > 0 && (
                        <>
                          {/* Text filter input */}
                          <input
                            type="text"
                            value={filterText}
                            onChange={(e) => setFilterText(e.target.value)}
                            placeholder="Filter results..."
                            className="w-64 rounded-lg border border-slate-600 bg-slate-700 px-3 py-1.5 text-sm text-slate-200 placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
                          />
                          {/* Sort dropdown */}
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs text-slate-500">Sort:</span>
                            <select
                              value={sortBy}
                              onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                              className="rounded border border-slate-600 bg-slate-700 px-2 py-0.5 text-xs text-slate-200 focus:border-emerald-500 focus:outline-none"
                            >
                              <option value="relevance">Relevance</option>
                              <option value="series">Series</option>
                              <option value="title">Title</option>
                              <option value="year">Year</option>
                            </select>
                          </div>
                          {/* Include owned checkbox */}
                          <div className="flex items-center gap-1.5">
                            <input
                              type="checkbox"
                              id="includeOwned"
                              checked={includeOwned}
                              onChange={(e) => setIncludeOwned(e.target.checked)}
                              className="h-3.5 w-3.5 rounded border-slate-600 bg-slate-700 text-emerald-600 focus:ring-emerald-500"
                            />
                            <label
                              htmlFor="includeOwned"
                              className="text-xs text-slate-500 cursor-pointer"
                              title="Show books you already own in results"
                            >
                              Include owned
                            </label>
                          </div>
                        </>
                      )}
                    </div>
                    {/* Right: Caching indicator, Result count */}
                    <div className="flex items-center gap-2 text-xs text-slate-500">
                      {seriesEnrichProgress && (
                        <span
                          className={`flex items-center gap-1.5 ${seriesEnrichError ? "text-red-400" : "text-emerald-400"}`}
                          title={seriesEnrichError ?? undefined}
                        >
                          <span className={`h-2 w-2 rounded-full ${seriesEnrichError ? "bg-red-500" : "animate-pulse bg-emerald-500"}`} />
                          Caching {seriesEnrichProgress.current}/{seriesEnrichProgress.total}
                        </span>
                      )}
                      <span>
                        {sortedResults.length} of {results.length} result{results.length !== 1 ? "s" : ""}
                      </span>
                    </div>
                  </div>

                  {results.length === 0 ? (
                    <div className="text-sm text-slate-400">
                      No results found. Try adjusting your search query.
                    </div>
                  ) : (
                    <div 
                      ref={resultsListRef}
                      className="rounded-lg border border-slate-700 bg-slate-900/40 overflow-hidden max-h-[500px] overflow-y-auto"
                    >
                      {sortedResults.map((result, index) => (
                        <SearchResultRow
                          key={result._key}
                          result={result}
                          index={index}
                          coverUrl={getOwnedCover(result) || result.cover_url}
                          isOwned={isOwned(result)}
                          isInCatalogMissing={isInCatalogMissing(result)}
                          isEnriched={seriesCache.has(`${result.provider}:${result.id}`)}
                          enrichedData={seriesCache.get(`${result.provider}:${result.id}`)}
                          dbIsbn={getMatchedBook(result)?.isbn}
                          dbSeriesData={(() => {
                            const m = getMatchedBook(result);
                            return m ? { series_name: m.series_name, series_position: m.series_position, series_count: m.series_count } : null;
                          })()}
                          onVisible={handleRowVisible}
                          onResultClick={handleResultClick}
                          onTitleClick={handleTitleClick}
                          onAuthorClick={handleAuthorClick}
                          onSeriesClick={handleSeriesClick}
                          onInfoClick={(r) => {
                            // Save scroll position before navigating to info
                            if (resultsListRef.current) {
                              savedScrollPosition.current = resultsListRef.current.scrollTop;
                              shouldRestoreScroll.current = true;
                              console.log(`[ScrollRestore] Saved scroll position (info): ${savedScrollPosition.current} (heap: ${getHeapMB()}MB)`);
                            }
                            setSelectedBook(r);
                            setBookInfo(null);
                            setView("info");
                          }}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* INFO VIEW */}
          {isConfigured && view === "info" && selectedBook && (
            <>
              {/* Back button */}
              <button
                type="button"
                onClick={() => setView("search")}
                className="mb-4 flex items-center gap-1 text-sm text-slate-400 hover:text-slate-200"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
                Back to search results
              </button>

              {/* Bulk navigation in info view */}
              {isBulkMode && bulkBooks && (
                <div className="mb-4 flex items-center gap-2">
                  <div className="flex items-center gap-1 rounded-lg border border-slate-600 bg-slate-700 px-1">
                    <button
                      type="button"
                      onClick={handleBulkPrev}
                      disabled={bulkIndex === 0 || searchMutation.isPending}
                      className="rounded p-1.5 text-slate-400 hover:bg-slate-600 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
                      title="Previous book"
                    >
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                      </svg>
                    </button>
                    <span className="min-w-[4rem] text-center text-sm text-slate-300">
                      {bulkIndex + 1} of {bulkBooks.length}
                    </span>
                    <button
                      type="button"
                      onClick={handleBulkNext}
                      disabled={bulkIndex === bulkBooks.length - 1 || searchMutation.isPending}
                      className="rounded p-1.5 text-slate-400 hover:bg-slate-600 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
                      title="Next book"
                    >
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={handleBulkRetry}
                    disabled={searchMutation.isPending}
                    className="rounded-lg border border-slate-600 bg-slate-700 p-1.5 text-slate-400 hover:bg-slate-600 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
                    title="Retry search for this book"
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  </button>
                </div>
              )}

              {/* Book info content */}
              {(() => {
                // Get matched book from our DB (provider-match)
                const matched = getMatchedBook(selectedBook);
                
                // Display priority: search result > our DB > (get_book is test-only)
                // Fill in missing search data from our DB
                const displayYear = selectedBook.year 
                  || (matched?.release_date ? new Date(matched.release_date).getFullYear() : null);
                
                // Rating/Readers: use search result (has formatted "3.8 (21)" style)
                const ratingField = selectedBook.display_fields?.find(f => f.icon === "star");
                const readersField = selectedBook.display_fields?.find(f => f.icon === "users");
                
                // Series: search result, fallback to our DB
                const displaySeriesName = selectedBook.series_name || matched?.series_name;
                const displaySeriesPosition = selectedBook.series_position ?? matched?.series_position;
                const displaySeriesCount = selectedBook.series_count ?? matched?.series_count;
                
                // ISBN: search result, fallback to our DB (common case: search has none, we have it)
                const displayIsbn = selectedBook.isbn || matched?.isbn;
                
                // Description: search result, fallback to our DB
                const displayDescription = selectedBook.description || matched?.description;
                
                return (
              <div className="flex flex-col gap-6 lg:flex-row lg:gap-8">
                {/* Cover - larger sizing like SM, with owned/watching badge overlay */}
                <div className="relative flex justify-center lg:justify-start lg:self-start">
                  {(() => {
                    // Prefer our owned cover, then selectedBook (search result)
                    const coverUrl = getOwnedCover(selectedBook) || selectedBook.cover_url;
                    return coverUrl ? (
                      <img
                        src={coverUrl}
                        alt=""
                        className="max-h-[60vh] w-auto max-w-[432px] rounded-xl border border-slate-600 object-contain bg-slate-800 shadow-lg"
                        onError={(e) => {
                          e.currentTarget.style.display = "none";
                          e.currentTarget.nextElementSibling?.classList.remove("hidden");
                        }}
                      />
                    ) : null;
                  })()}
                  <div className={`flex h-64 w-44 items-center justify-center rounded-xl border border-dashed border-slate-600 bg-slate-800/60 text-sm text-slate-500 ${(getOwnedCover(selectedBook) || selectedBook.cover_url) ? "hidden" : ""}`}>
                    No cover
                  </div>
                  {/* Owned badge - top right of cover */}
                  {isOwned(selectedBook) && (
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
                  {isInCatalogMissing(selectedBook) && (
                    <div className="absolute top-2 right-2 rounded-full bg-amber-500 p-1.5" title="In catalog (watching)">
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="white">
                        <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>
                      </svg>
                    </div>
                  )}
                </div>

                {/* Metadata - compact layout */}
                <div className="flex-1 space-y-3">
                  {/* Top row: Year, Rating, Readers - search result > our DB */}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-300">
                    {displayYear && (
                      <span>{displayYear}</span>
                    )}
                    {ratingField && (
                      <span className="flex items-center gap-1">
                        <span className="text-amber-400">★</span>
                        <span>{ratingField.value}</span>
                        {ratingField.label && <span className="text-slate-500">{ratingField.label}</span>}
                      </span>
                    )}
                    {readersField && (
                      <span className="flex items-center gap-1">
                        <svg className="h-4 w-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z" />
                        </svg>
                        <span>{readersField.value}</span>
                        <span className="text-slate-500">{readersField.label}</span>
                      </span>
                    )}
                  </div>

                  {/* Format badges - show all 4, highlight owned */}
                  {(() => {
                    const ownedFmts = new Set(getOwnedFormats(selectedBook) || []);
                    return (
                      <div className="flex flex-wrap gap-1.5">
                        {Object.entries(FORMAT_BADGE_STYLES).map(([key, style]) => {
                          const owned = ownedFmts.has(key);
                          return (
                            <span
                              key={key}
                              className={`rounded px-2 py-0.5 text-xs font-medium ${
                                owned ? style.className : "bg-slate-700/50 text-slate-500"
                              }`}
                            >
                              {style.label}
                            </span>
                          );
                        })}
                      </div>
                    );
                  })()}

                  {/* Series line - search > our DB */}
                  {displaySeriesName && (
                    <button
                      type="button"
                      onClick={() => handleSeriesClick(
                        displaySeriesName,
                        selectedBook.author,
                        selectedBook.series_id
                      )}
                      className="text-sm font-medium text-emerald-400 hover:text-emerald-300 hover:underline text-left"
                    >
                      {(() => {
                        if (displaySeriesPosition != null) {
                          return (
                            <>#{displaySeriesPosition}{displaySeriesCount ? ` of ${displaySeriesCount}` : ""} in {displaySeriesName}</>
                          );
                        }
                        return displaySeriesName;
                      })()}
                    </button>
                  )}

                  {/* Description - search > our DB */}
                  {displayDescription && (
                    <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4 max-h-[480px] overflow-y-auto">
                      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">Description</div>
                      <div className="text-sm text-slate-300 leading-relaxed whitespace-pre-line">
                        {stripHtml(displayDescription)}
                      </div>
                    </div>
                  )}

                  {/* TEST: Provider match data from our DB */}
                  {(() => {
                    const matched = getMatchedBook(selectedBook);
                    if (!matched) {
                      return (
                        <div className="rounded-lg border border-cyan-700 bg-cyan-800/20 p-4">
                          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-cyan-500">TEST: Our DB (provider-match)</div>
                          <div className="text-sm text-slate-400">No match found in our DB for this book</div>
                        </div>
                      );
                    }
                    return (
                      <div className="rounded-lg border border-cyan-700 bg-cyan-800/20 p-4 max-h-[320px] overflow-y-auto">
                        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-cyan-500">TEST: Our DB (provider-match) - book_id={matched.book_id}</div>
                        <div className="text-sm text-slate-300 space-y-1">
                          <div><span className="text-cyan-400">is_owned:</span> {matched.is_owned ? "✓ Yes" : "No"}</div>
                          <div><span className="text-cyan-400">formats:</span> {matched.formats.length > 0 ? matched.formats.join(", ") : "none"}</div>
                          <div><span className="text-cyan-400">isbn:</span> {matched.isbn || "none"}</div>
                          <div><span className="text-cyan-400">release_date:</span> {matched.release_date || "none"}</div>
                          <div><span className="text-cyan-400">series:</span> {matched.series_name ? `#${matched.series_position ?? "?"} of ${matched.series_count ?? "?"} in ${matched.series_name}` : "none"}</div>
                          <div><span className="text-cyan-400">rating:</span> {matched.rating != null ? matched.rating.toFixed(2) : "none"}</div>
                          <div><span className="text-cyan-400">description:</span> {matched.description ? `${matched.description.length} chars` : "none"}</div>
                          {matched.cover_path && <div><span className="text-cyan-400">cover_path:</span> {matched.cover_path}</div>}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Bottom row: ISBN (search > our DB) and View on source - inline */}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                    {displayIsbn && (
                      <span className="text-slate-400">
                        ISBN: <span className="font-mono text-slate-300">{displayIsbn}</span>
                      </span>
                    )}
                    {selectedBook.source_url && (
                      <a
                        href={selectedBook.source_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-emerald-400 hover:text-emerald-300 transition-colors"
                      >
                        View on {(() => {
                          const src = (selectedBook.source || "").toLowerCase();
                          if (src.includes("hardcover")) return "Hardcover";
                          if (src.includes("google")) return "Google Books";
                          if (src.includes("openlibrary") || src.includes("open library")) return "Open Library";
                          return "Source";
                        })()}
                      </a>
                    )}
                  </div>
                </div>
              </div>
                );
              })()}
            </>
          )}

          {/* RELEASES VIEW */}
          {isConfigured && view === "releases" && (
            <>
              {/* Back button */}
              <button
                type="button"
                onClick={handleBackToSearch}
                className="mb-4 flex items-center gap-1 text-sm text-slate-400 hover:text-slate-200"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
                Back to search results
              </button>

              {/* Bulk navigation in releases view */}
              {isBulkMode && bulkBooks && (
                <div className="mb-4 flex items-center gap-2">
                  <div className="flex items-center gap-1 rounded-lg border border-slate-600 bg-slate-700 px-1">
                    <button
                      type="button"
                      onClick={handleBulkPrev}
                      disabled={bulkIndex === 0 || releasesMutation.isPending}
                      className="rounded p-1.5 text-slate-400 hover:bg-slate-600 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
                      title="Previous book"
                    >
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                      </svg>
                    </button>
                    <span className="min-w-[4rem] text-center text-sm text-slate-300">
                      {bulkIndex + 1} of {bulkBooks.length}
                    </span>
                    <button
                      type="button"
                      onClick={handleBulkNext}
                      disabled={bulkIndex === bulkBooks.length - 1 || releasesMutation.isPending}
                      className="rounded p-1.5 text-slate-400 hover:bg-slate-600 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
                      title="Next book"
                    >
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => selectedBook && handleResultClick(selectedBook)}
                    disabled={releasesMutation.isPending || !selectedBook}
                    className="rounded-lg border border-slate-600 bg-slate-700 p-1.5 text-slate-400 hover:bg-slate-600 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
                    title="Retry find releases"
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  </button>
                </div>
              )}

              {/* Book info header */}
              {(bookInfo || selectedBook) && (() => {
                const matched = selectedBook ? getMatchedBook(selectedBook) : null;
                return (
                <div className="mb-5 rounded-xl border border-slate-700 bg-slate-800 p-4">
                  <div className="flex gap-4">
                    {/* Cover - prefer owned cover, with owned/watching badge overlay */}
                    <div className="relative shrink-0">
                      {(() => {
                        const coverUrl = (selectedBook && getOwnedCover(selectedBook)) || bookInfo?.cover_url || selectedBook?.cover_url;
                        return coverUrl ? (
                          <img
                            src={coverUrl}
                            alt=""
                            className="h-32 w-24 rounded border border-slate-600 object-cover bg-slate-700"
                            onError={(e) => {
                              e.currentTarget.style.display = "none";
                              e.currentTarget.nextElementSibling?.classList.remove("hidden");
                            }}
                          />
                        ) : null;
                      })()}
                      <div className={`flex h-32 w-24 items-center justify-center rounded border border-slate-600 bg-slate-700 text-xs text-slate-500 ${((selectedBook && getOwnedCover(selectedBook)) || bookInfo?.cover_url || selectedBook?.cover_url) ? "hidden" : ""}`}>
                        No cover
                      </div>
                      {/* Owned badge - top right of cover */}
                      {selectedBook && isOwned(selectedBook) && (
                        <div className="absolute top-1 right-1 rounded-full bg-emerald-500 p-1" title="Owned">
                          <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                            <path
                              fillRule="evenodd"
                              d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 111.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                              clipRule="evenodd"
                            />
                          </svg>
                        </div>
                      )}
                      {/* Watching badge - top right of cover (in catalog but not owned) */}
                      {selectedBook && isInCatalogMissing(selectedBook) && (
                        <div className="absolute top-1 right-1 rounded-full bg-amber-500 p-1" title="In catalog (watching)">
                          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="white">
                            <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>
                          </svg>
                        </div>
                      )}
                    </div>

                    {/* Info */}
                    <div className="min-w-0 flex-1">
                      {/* Year and display fields (rating, readers) - from selectedBook */}
                      <div className="flex flex-wrap items-center gap-3 text-sm text-slate-400">
                        {(bookInfo?.year || selectedBook?.year) && (
                          <span>{bookInfo?.year || selectedBook?.year}</span>
                        )}
                        {/* Display fields - from selectedBook */}
                        {(selectedBook?.display_fields || []).map((field, idx) => (
                          <span key={idx} className="flex items-center gap-1">
                            {field.icon === "star" && <span className="text-amber-400">★</span>}
                            {field.icon === "users" && <span>👥</span>}
                            <span>{field.value}</span>
                            {field.label && <span className="text-slate-500">{field.label}</span>}
                          </span>
                        ))}
                      </div>

                      {/* Format badges - show all 4, highlight owned */}
                      {selectedBook && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {(() => {
                            const ownedFmts = new Set(getOwnedFormats(selectedBook) || []);
                            return Object.entries(FORMAT_BADGE_STYLES).map(([key, style]) => {
                              const owned = ownedFmts.has(key);
                              return (
                                <span
                                  key={key}
                                  className={`rounded px-2 py-0.5 text-xs font-medium ${
                                    owned ? style.className : "bg-slate-700/50 text-slate-500"
                                  }`}
                                >
                                  {style.label}
                                </span>
                              );
                            });
                          })()}
                        </div>
                      )}
                      
                      {/* Series info - from selectedBook (preserves search context) */}
                      {(bookInfo?.series_name || selectedBook?.series_name) && (
                        <button
                          type="button"
                          onClick={() => handleSeriesClick(
                            bookInfo?.series_name || selectedBook?.series_name!,
                            bookInfo?.author || selectedBook?.author,
                            bookInfo?.series_id || selectedBook?.series_id
                          )}
                          className="mt-1 text-sm text-emerald-400 hover:text-emerald-300 hover:underline text-left"
                        >
                          {(() => {
                            const pos = bookInfo?.series_position ?? selectedBook?.series_position;
                            const count = selectedBook?.series_count;
                            const name = bookInfo?.series_name || selectedBook?.series_name;
                            if (pos != null) {
                              return `#${pos}${count ? ` of ${count}` : ""} in ${name}`;
                            }
                            return name;
                          })()}
                        </button>
                      )}
                      
                      {/* Description with expand/collapse - from selectedBook */}
                      {(bookInfo?.description || selectedBook?.description) && (
                        <div className="mt-2">
                          <p className={`text-sm text-slate-300 whitespace-pre-line ${descriptionExpanded ? "" : "line-clamp-3"}`}>
                            {stripHtml(bookInfo?.description || selectedBook?.description)}
                          </p>
                          {((stripHtml(bookInfo?.description || selectedBook?.description) || "").length > 200) && (
                            <button
                              type="button"
                              onClick={() => setDescriptionExpanded(!descriptionExpanded)}
                              className="mt-1 text-xs text-emerald-400 hover:text-emerald-300"
                            >
                              {descriptionExpanded ? "less" : "more"}
                            </button>
                          )}
                        </div>
                      )}
                      
                      {/* ISBN and source link - prefer our DB for ISBN */}
                      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
                        {(matched?.isbn || bookInfo?.isbn || selectedBook?.isbn) && (
                          <span className="text-slate-500">
                            ISBN: {matched?.isbn || bookInfo?.isbn || selectedBook?.isbn}
                          </span>
                        )}
                        {(bookInfo?.source_url || selectedBook?.source_url) && (
                          <a
                            href={bookInfo?.source_url || selectedBook?.source_url || ""}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-emerald-400 hover:text-emerald-300"
                          >
                            View on {(() => {
                              const prov = bookInfo?.provider || selectedBook?.source || "";
                              if (prov.toLowerCase().includes("hardcover")) return "Hardcover";
                              if (prov.toLowerCase().includes("google")) return "Google Books";
                              if (prov.toLowerCase().includes("openlibrary")) return "Open Library";
                              return prov || "source";
                            })()}
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
                );
              })()}

              {/* Loading state */}
              {releasesMutation.isPending && (
                <div className="flex flex-col items-center justify-center py-12">
                  <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-600 border-t-emerald-500" />
                  <div className="mt-4 text-sm text-slate-400">Finding releases...</div>
                  <div className="mt-1 text-xs text-slate-500">This may take a while</div>
                </div>
              )}

              {/* Error */}
              {releasesError && (
                <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4">
                  <div className="text-sm text-rose-300">{releasesError}</div>
                </div>
              )}

              {/* In-progress downloads */}
              {statusData && statusData.in_progress && statusData.in_progress.length > 0 && (
                <div className="mb-4 rounded-xl border border-slate-700 bg-slate-800 p-4">
                  <div className="mb-3 flex items-center gap-2">
                    <div className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
                    <span className="text-xs font-medium uppercase tracking-wide text-slate-400">
                      In Progress
                    </span>
                    <span className="rounded bg-slate-700 px-1.5 py-0.5 text-xs text-slate-400">
                      {statusData.in_progress.length}
                    </span>
                  </div>
                  <div className="space-y-3">
                    {statusData.in_progress.map((item) => (
                      <div key={item.source_id} className="flex items-center gap-3">
                        {/* Cover */}
                        {item.cover_url ? (
                          <img
                            src={item.cover_url}
                            alt=""
                            className="h-12 w-9 shrink-0 rounded border border-slate-600 object-cover bg-slate-700"
                            onError={(e) => {
                              e.currentTarget.style.display = "none";
                              e.currentTarget.nextElementSibling?.classList.remove("hidden");
                            }}
                          />
                        ) : null}
                        <div className={`flex h-12 w-9 shrink-0 items-center justify-center rounded border border-slate-600 bg-slate-700 text-[8px] text-slate-500 ${item.cover_url ? "hidden" : ""}`}>
                          No Cover
                        </div>
                        {/* Info */}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium text-slate-100">
                              {item.title}
                            </span>
                            {item.author && (
                              <span className="truncate text-sm text-slate-500">
                                — {item.author}
                              </span>
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
                          {/* Status message and progress */}
                          <div className="mt-1.5">
                            {/* Progress bar - always visible */}
                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-700">
                              <div
                                className={`h-full rounded-full transition-all duration-300 ${getStatusBarColor(item.status)}`}
                                style={{ width: `${getStatusProgress(item.status, item.progress)}%` }}
                              />
                            </div>
                            {/* Status text below bar */}
                            <div className="mt-1 flex items-center justify-between text-xs">
                              <span className={getStatusTextColor(item.status)}>
                                {item.status === "downloading" && item.progress > 0 && item.size
                                  ? formatDownloadProgress(item.progress, item.size)
                                  : (item.status_message || formatStatus(item.status))}
                              </span>
                              {item.status === "downloading" && item.progress > 0 && (
                                <span className="text-slate-500">
                                  {Math.round(Math.min(100, item.progress))}%
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                        {/* Cancel button */}
                        <div className="flex shrink-0 items-center">
                          <button
                            type="button"
                            onClick={() => handleCancelDownload(item.source_id)}
                            disabled={cancelMutation.isPending}
                            className="rounded p-1 text-slate-500 transition-colors hover:bg-slate-700 hover:text-rose-400"
                            title="Cancel download"
                          >
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Finished downloads (failed first, then complete) - filtered by dismissed */}
              {statusData && (() => {
                const visibleFailed = statusData.failed.filter(d => !dismissedIds.has(d.source_id));
                const visibleComplete = statusData.complete.filter(d => !dismissedIds.has(d.source_id));
                const hasVisible = visibleFailed.length > 0 || visibleComplete.length > 0;
                
                if (!hasVisible) return null;
                
                const handleRetryItem = (sourceId: string) => {
                  retryMutation.mutate(sourceId, {
                    onSuccess: () => {
                      // Remove from finished states
                      setCompletedIds(prev => {
                        const next = new Set(prev);
                        next.delete(sourceId);
                        return next;
                      });
                      setCancelledIds(prev => {
                        const next = new Set(prev);
                        next.delete(sourceId);
                        return next;
                      });
                      setDismissedIds(prev => {
                        const next = new Set(prev);
                        next.delete(sourceId);
                        return next;
                      });
                      // Clear from seen so it can be re-tracked
                      setSeenInProgressIds(prev => {
                        const next = new Set(prev);
                        next.delete(sourceId);
                        return next;
                      });
                      // Add to initiated so it shows in In Progress immediately
                      setInitiatedIds(prev => new Set([...prev, sourceId]));
                      // Restart polling to track the retried download
                      setPollStatus(true);
                    },
                  });
                };

                const handleDismissItem = (sourceId: string) => {
                  dismissMutation.mutate([sourceId], {
                    onSuccess: () => {
                      setDismissedIds(prev => new Set([...prev, sourceId]));
                    },
                  });
                };
                
                const handleClearAll = () => {
                  const allIds = [...visibleFailed.map(d => d.source_id), ...visibleComplete.map(d => d.source_id)];
                  dismissMutation.mutate(allIds, {
                    onSuccess: () => {
                      setDismissedIds(prev => new Set([...prev, ...allIds]));
                    },
                  });
                };
                
                return (
                  <div className="mb-4 rounded-xl border border-slate-700 bg-slate-800 p-4">
                    <div className="mb-3 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium uppercase tracking-wide text-slate-400">
                          Finished
                        </span>
                        {visibleFailed.length > 0 && (
                          <span className="rounded bg-red-500/20 px-1.5 py-0.5 text-xs text-red-400">
                            Failed {visibleFailed.length}
                          </span>
                        )}
                        {visibleComplete.length > 0 && (
                          <span className="rounded bg-green-500/20 px-1.5 py-0.5 text-xs text-green-400">
                            Complete {visibleComplete.length}
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={handleClearAll}
                        disabled={dismissMutation.isPending}
                        className="text-xs text-slate-400 transition-colors hover:text-slate-200"
                      >
                        {dismissMutation.isPending ? "Clearing..." : "Clear All"}
                      </button>
                    </div>
                    <div className="space-y-3">
                      {/* Failed items first */}
                      {visibleFailed.map((item) => (
                        <div key={item.source_id} className="flex items-center gap-3">
                          {/* Cover */}
                          {item.cover_url ? (
                            <img
                              src={item.cover_url}
                              alt=""
                              className="h-12 w-9 shrink-0 rounded border border-slate-600 object-cover bg-slate-700"
                              onError={(e) => {
                                e.currentTarget.style.display = "none";
                                e.currentTarget.nextElementSibling?.classList.remove("hidden");
                              }}
                            />
                          ) : null}
                          <div className={`flex h-12 w-9 shrink-0 items-center justify-center rounded border border-slate-600 bg-slate-700 text-[8px] text-slate-500 ${item.cover_url ? "hidden" : ""}`}>
                            No Cover
                          </div>
                          {/* Info */}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-medium text-slate-100">
                                {item.title}
                              </span>
                              {item.author && (
                                <span className="truncate text-sm text-slate-500">
                                  — {item.author}
                                </span>
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
                            <div className="mt-1 text-xs text-red-400">
                              {item.status === "cancelled" ? "Cancelled" : (item.status_message || "Error")}
                            </div>
                          </div>
                          {/* Action buttons: retry (left) + dismiss (right) */}
                          <div className="flex shrink-0 items-center">
                            <button
                              type="button"
                              onClick={() => handleRetryItem(item.source_id)}
                              disabled={retryMutation.isPending}
                              className="rounded p-1 text-slate-500 transition-colors hover:bg-slate-700 hover:text-slate-300"
                              title="Retry download"
                            >
                              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                              </svg>
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDismissItem(item.source_id)}
                              disabled={dismissMutation.isPending}
                              className="rounded p-1 text-slate-500 transition-colors hover:bg-slate-700 hover:text-rose-400"
                              title="Dismiss"
                            >
                              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                          </div>
                        </div>
                      ))}
                      {/* Complete items */}
                      {visibleComplete.map((item) => (
                        <div key={item.source_id} className="flex items-center gap-3">
                          {/* Cover */}
                          {item.cover_url ? (
                            <img
                              src={item.cover_url}
                              alt=""
                              className="h-12 w-9 shrink-0 rounded border border-slate-600 object-cover bg-slate-700"
                              onError={(e) => {
                                e.currentTarget.style.display = "none";
                                e.currentTarget.nextElementSibling?.classList.remove("hidden");
                              }}
                            />
                          ) : null}
                          <div className={`flex h-12 w-9 shrink-0 items-center justify-center rounded border border-slate-600 bg-slate-700 text-[8px] text-slate-500 ${item.cover_url ? "hidden" : ""}`}>
                            No Cover
                          </div>
                          {/* Info */}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-medium text-slate-100">
                                {item.title}
                              </span>
                              {item.author && (
                                <span className="truncate text-sm text-slate-500">
                                  — {item.author}
                                </span>
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
                            <div className="mt-1 text-xs text-green-400">
                              Complete
                            </div>
                          </div>
                          {/* Dismiss button only (no retry for complete) - with spacer to align with failed items */}
                          <div className="flex shrink-0 items-center">
                            <div className="w-6" /> {/* Spacer for retry button width */}
                            <button
                              type="button"
                              onClick={() => handleDismissItem(item.source_id)}
                              disabled={dismissMutation.isPending}
                              className="rounded p-1 text-slate-500 transition-colors hover:bg-slate-700 hover:text-rose-400"
                              title="Dismiss"
                            >
                              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {/* Download success message removed - stale message issue fixed */}

              {/* Download error - shown without hiding releases */}
              {downloadError && (
                <div className="mb-4 rounded-xl border border-rose-500/30 bg-rose-500/10 p-4">
                  <div className="flex items-center justify-between">
                    <div className="text-sm text-rose-300">{downloadError}</div>
                    <button
                      type="button"
                      onClick={() => setDownloadError(null)}
                      className="ml-2 rounded p-1 text-rose-400 hover:bg-rose-500/20"
                      title="Dismiss"
                    >
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                </div>
              )}

              {/* Releases */}
              {!releasesMutation.isPending && !releasesError && releases.length > 0 && (
                <div className="rounded-xl border border-slate-700 bg-slate-800">
                  {/* Source tabs */}
                  {sources.length > 0 && (
                    <div className="flex border-b border-slate-700">
                      {sources.map((source) => {
                        const count = releases.filter((r) => r.source === source).length;
                        return (
                          <button
                            key={source}
                            type="button"
                            onClick={() => setActiveSource(source)}
                            className={`px-4 py-3 text-sm font-medium transition-colors ${
                              activeSource === source
                                ? "border-b-2 border-emerald-500 text-emerald-400"
                                : "text-slate-400 hover:text-slate-200"
                            }`}
                          >
                            {getSourceDisplayName(source)}
                            <span className="ml-2 text-xs text-slate-500">({count})</span>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {/* Release rows */}
                  <div className="divide-y divide-slate-700">
                    {filteredReleases.map((release, index) => (
                      <div
                        key={`${release.source}-${release.source_id}-${index}`}
                        className="flex items-center gap-3 px-4 py-3"
                      >
                        {/* Small cover */}
                        {release.cover_url ? (
                          <img
                            src={release.cover_url}
                            alt=""
                            className="h-12 w-9 shrink-0 rounded border border-slate-600 object-cover bg-slate-700"
                            onError={(e) => {
                              e.currentTarget.style.display = "none";
                              e.currentTarget.nextElementSibling?.classList.remove("hidden");
                            }}
                          />
                        ) : null}
                        <div className={`flex h-12 w-9 shrink-0 items-center justify-center rounded border border-slate-600 bg-slate-700 text-[8px] text-slate-500 ${release.cover_url ? "hidden" : ""}`}>
                          No cover
                        </div>

                        {/* Title & author */}
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-slate-100">{release.title}</div>
                          {release.author && (
                            <div className="truncate text-xs text-slate-400">{release.author}</div>
                          )}
                        </div>

                        {/* Language badge */}
                        {release.language && (
                          <span
                            className={`shrink-0 rounded px-2 py-0.5 text-[10px] font-semibold uppercase text-white ${getLanguageBadgeColor(
                              release.language
                            )}`}
                          >
                            {release.language}
                          </span>
                        )}

                        {/* Format badge */}
                        {release.format && (
                          <span
                            className={`shrink-0 rounded px-2 py-0.5 text-[10px] font-semibold uppercase text-white ${getFormatBadgeColor(
                              release.format
                            )}`}
                          >
                            {release.format}
                          </span>
                        )}

                        {/* Size */}
                        <span className="w-16 shrink-0 text-right text-xs text-slate-400">
                          {release.size || "-"}
                        </span>

                        {/* Download button / status indicator */}
                        {(() => {
                          const isDownloading = downloadingId === release.source_id;
                          const isInProgress = statusData?.in_progress?.some(d => d.source_id === release.source_id);
                          const isCompleted = completedIds.has(release.source_id);
                          
                          if (isCompleted) {
                            // Green checkmark for completed
                            return (
                              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-500">
                                <svg className="h-5 w-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                                </svg>
                              </div>
                            );
                          }
                          
                          if (isDownloading || isInProgress) {
                            // Spinner for downloading/in-progress
                            return (
                              <div className="flex h-8 w-8 shrink-0 items-center justify-center">
                                <svg className="h-6 w-6 animate-spin text-slate-400" fill="none" viewBox="0 0 24 24">
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
                              </div>
                            );
                          }
                          
                          // Download arrow button
                          return (
                            <button
                              type="button"
                              onClick={() => handleDownload(release)}
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
                          );
                        })()}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* No releases */}
              {!releasesMutation.isPending && !releasesError && releases.length === 0 && (
                <div className="rounded-xl border border-slate-700 bg-slate-800 p-8 text-center">
                  <div className="text-sm text-slate-400">No releases found for this book.</div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-end gap-3 border-t border-slate-700 px-6 py-4">
          {view === "info" && selectedBook && (
            <button
              type="button"
              onClick={() => handleResultClick(selectedBook)}
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
      </div>
    </div>,
    document.body
  );
}
