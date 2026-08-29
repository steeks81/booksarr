import React, { useEffect, useMemo, useState } from "react";
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
  useShelfmarkBookDetail,
  enrichSeriesStream,
  type ShelfmarkSearchResult,
  type ShelfmarkBookInfo,
  type ShelfmarkRelease,
  type ShelfmarkBookDetailResponse,
} from "../api/shelfmark";
import { useSettings } from "../api/settings";

// Strip HTML tags and convert paragraph breaks to newlines
function stripHtml(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<\/p>\s*<p>/gi, "\n\n")  // Convert </p><p> to double newline
    .replace(/<br\s*\/?>/gi, "\n")      // Convert <br> to newline
    .replace(/<[^>]+>/g, "")            // Strip remaining HTML tags
    .trim();
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

export default function ShelfmarkSearchDialog({
  bookId,
  title,
  authorName,
  series,
  authorSearch,
  open,
  onClose,
}: {
  bookId: number | null;
  title: string;
  authorName: string | null;
  series?: string | null;
  authorSearch?: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const { data: settings } = useSettings();
  const searchMutation = useShelfmarkSearch();
  const releasesMutation = useShelfmarkReleases();
  const downloadMutation = useShelfmarkDownload();
  const cancelMutation = useShelfmarkCancel();
  const retryMutation = useShelfmarkRetry();
  const dismissMutation = useShelfmarkDismiss();
  const bookDetailMutation = useShelfmarkBookDetail();
  
  // Poll for download status when in releases view
  const [pollStatus, setPollStatus] = useState(false);
  const { data: statusData } = useShelfmarkStatus(pollStatus, 2000);

  // Search state - separate query text per search field (like SM does)
  const [searchField, setSearchField] = useState<"general" | "author" | "title" | "series">("general");
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
  const [results, setResults] = useState<ShelfmarkSearchResult[]>([]);
  const [shelfmarkUrl, setShelfmarkUrl] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [sortBy, setSortBy] = useState<"default" | "series" | "title" | "year">("default");
  
  // Track last executed search to avoid redundant requests
  const [lastSearch, setLastSearch] = useState<{ field: string; query: string } | null>(null);

  // Releases view state
  const [view, setView] = useState<"search" | "info" | "releases">("search");
  const [selectedBook, setSelectedBook] = useState<ShelfmarkSearchResult | null>(null);
  const [bookInfo, setBookInfo] = useState<ShelfmarkBookInfo | null>(null);
  const [bookDetailFull, setBookDetailFull] = useState<ShelfmarkBookDetailResponse | null>(null);
  const [releases, setReleases] = useState<ShelfmarkRelease[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [activeSource, setActiveSource] = useState<string | null>(null);
  const [releasesError, setReleasesError] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadSuccess, setDownloadSuccess] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  
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
  
  // Direct search option - bypasses SM's metadata lookup
  const [directSearch, setDirectSearch] = useState(false);
  
  // Info view loading state
  const [detailLoading, setDetailLoading] = useState(false);
  
  // Series enrichment progress tracking
  const [seriesEnrichProgress, setSeriesEnrichProgress] = useState<{ current: number; total: number } | null>(null);
  const enrichAbortRef = React.useRef<AbortController | null>(null);
  
  // Series cache: provider:bookId -> series info (cleared on dialog close)
  const [seriesCache, setSeriesCache] = useState<Map<string, {
    series_name: string | null;
    series_position: number | null;
    series_count: number | null;
  }>>(new Map());
  
  // Sorted results based on sortBy selection
  const sortedResults = useMemo(() => {
    if (sortBy === "default") return results;
    return [...results].sort((a, b) => {
      switch (sortBy) {
        case "series": {
          // Treat empty string same as no series
          const seriesA = a.series_name?.trim() || "\uffff";
          const seriesB = b.series_name?.trim() || "\uffff";
          if (seriesA !== seriesB) return seriesA.localeCompare(seriesB);
          return (a.series_position ?? 999) - (b.series_position ?? 999);
        }
        case "title":
          return (a.title || "").localeCompare(b.title || "");
        case "year":
          return (b.year ?? 0) - (a.year ?? 0); // Newest first
        default:
          return 0;
      }
    });
  }, [results, sortBy]);
  
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
      // Cancel any in-progress series enrichment
      enrichAbortRef.current?.abort();
      enrichAbortRef.current = null;
      // Clear series cache on close
      setSeriesCache(new Map());
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
    setQueryTextByField({
      general: [authorSearch || authorName || "", title].filter(Boolean).join(" ").trim(),
      author: authorSearch || authorName || "",
      title: title || "",
      series: series || "",
    });
    setResults([]);
    setShelfmarkUrl(null);
    setSearchError(null);
    setHasSearched(false);
    setLastSearch(null);
    setView("search");
    setSelectedBook(null);
    setBookInfo(null);
    setBookDetailFull(null);
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
    setDirectSearch(false);
    setDetailLoading(false);
    setPollStatus(false);
    setSeriesEnrichProgress(null);
    // Note: sortBy intentionally not reset - preserve user's preference
    
    // Auto-search when opened with author, series, or title
    if (authorSearch || series || title) {
      const doAutoSearch = async () => {
        try {
          const searchParams: { series?: string; author?: string; title?: string; query?: string; media_type: "ebook" | "audiobook" } = {
            media_type: "ebook",
          };
          
          if (initialField === "author") {
            searchParams.author = authorSearch || authorName || "";
          } else if (initialField === "series") {
            searchParams.series = series || "";
            // Don't filter by author for series search - series name is specific enough
            // and author filter causes issues with co-authored books
          } else if (initialField === "title") {
            searchParams.title = title || "";
          } else {
            searchParams.query = [authorName ?? "", title].filter(Boolean).join(" ").trim();
          }
          
          const response = await searchMutation.mutateAsync(searchParams);

          if (response.error) {
            setSearchError(response.error);
            setResults([]);
          } else {
            setResults(response.results);
            setShelfmarkUrl(response.shelfmark_url);
            setLastSearch({ field: initialField, query: searchParams.title || searchParams.author || searchParams.series || searchParams.query || "" });
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

  // Start series enrichment when results are loaded
  useEffect(() => {
    if (!hasSearched || results.length === 0 || seriesEnrichProgress !== null) return;
    
    // First, apply cached series data to results
    const resultsNeedingUpdate: Array<{ id: string; series_name: string | null; series_position: number | null; series_count: number | null }> = [];
    const booksNeedingFetch: Array<{ provider: string; book_id: string }> = [];
    
    for (const r of results) {
      if (!r.provider || r.series_position !== null) continue;
      
      const cacheKey = `${r.provider}:${r.id}`;
      const cached = seriesCache.get(cacheKey);
      
      if (cached) {
        // Use cached data
        resultsNeedingUpdate.push({
          id: r.id,
          series_name: cached.series_name,
          series_position: cached.series_position,
          series_count: cached.series_count,
        });
      } else {
        // Need to fetch
        booksNeedingFetch.push({ provider: r.provider, book_id: r.id });
      }
    }
    
    // Apply cached data immediately
    if (resultsNeedingUpdate.length > 0) {
      setResults(prev => prev.map(r => {
        const update = resultsNeedingUpdate.find(u => u.id === r.id);
        return update ? { ...r, ...update } : r;
      }));
    }
    
    // If nothing to fetch, we're done
    if (booksNeedingFetch.length === 0) return;
    
    // Create abort controller for this enrichment run
    const abortController = new AbortController();
    enrichAbortRef.current = abortController;
    
    // Start enrichment for uncached books only
    const doEnrich = async () => {
      setSeriesEnrichProgress({ current: 0, total: booksNeedingFetch.length });
      
      try {
        for await (const event of enrichSeriesStream(booksNeedingFetch, abortController.signal)) {
          if (abortController.signal.aborted) break;
          
          if (event.type === "progress") {
            setSeriesEnrichProgress({ current: event.current!, total: event.total! });
          } else if (event.type === "series" && event.book_id) {
            // Find the provider for this book to build cache key
            const bookEntry = booksNeedingFetch.find(b => b.book_id === event.book_id);
            if (bookEntry) {
              const cacheKey = `${bookEntry.provider}:${event.book_id}`;
              // Update cache
              setSeriesCache(prev => new Map(prev).set(cacheKey, {
                series_name: event.series_name ?? null,
                series_position: event.series_position ?? null,
                series_count: event.series_count ?? null,
              }));
            }
            
            // Update the specific result with series info
            setResults(prev => prev.map(r => 
              r.id === event.book_id
                ? {
                    ...r,
                    series_name: event.series_name ?? null,
                    series_position: event.series_position ?? null,
                    series_count: event.series_count ?? null,
                  }
                : r
            ));
          } else if (event.type === "done") {
            setSeriesEnrichProgress(null);
          }
        }
      } catch (err) {
        // Ignore abort errors (can be Error with name "AbortError" or DOMException)
        if (err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted"))) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("Series enrichment error:", err);
      } finally {
        setSeriesEnrichProgress(null);
        if (enrichAbortRef.current === abortController) {
          enrichAbortRef.current = null;
        }
      }
    };
    
    doEnrich();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasSearched, results.length]);

  // Fetch full book details when info view opens
  useEffect(() => {
    if (view !== "info" || !selectedBook) {
      return;
    }
    
    // Determine provider from source
    let provider = "hardcover"; // default
    const src = (selectedBook.source || "").toLowerCase();
    if (src.includes("google")) provider = "googlebooks";
    else if (src.includes("hardcover")) provider = "hardcover";
    else if (src.includes("openlibrary") || src.includes("open library")) provider = "openlibrary";
    
    const fetchDetails = async () => {
      setDetailLoading(true);
      setBookDetailFull(null);
      try {
        const response = await bookDetailMutation.mutateAsync({
          provider,
          bookId: selectedBook.id,
        });
        setBookDetailFull(response);
      } catch (err) {
        console.error("Failed to fetch book details:", err);
        // Keep showing basic info from search result
      } finally {
        setDetailLoading(false);
      }
    };
    
    fetchDetails();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, selectedBook?.id]); // Only re-run when view or selectedBook.id changes

  if (!open) return null;

  const isConfigured = Boolean(settings?.shelfmark_url && settings?.shelfmark_password_set);

  const handleSearch = async () => {
    if (!queryText.trim()) return;

    // Cancel any in-progress series enrichment
    enrichAbortRef.current?.abort();
    enrichAbortRef.current = null;
    
    setSearchError(null);
    setHasSearched(false);  // Reset to trigger series enrichment useEffect
    setSeriesEnrichProgress(null);

    try {
      const searchParams: { series?: string; author?: string; title?: string; query?: string; media_type: "ebook" | "audiobook" } = {
        media_type: "ebook",
      };
      
      // Build search params based on searchField
      if (searchField === "author") {
        searchParams.author = queryText.trim();
      } else if (searchField === "series") {
        searchParams.series = queryText.trim();
      } else if (searchField === "title") {
        searchParams.title = queryText.trim();
      } else {
        // "general" - use query param
        searchParams.query = queryText.trim();
      }
      
      const response = await searchMutation.mutateAsync(searchParams);

      if (response.error) {
        setSearchError(response.error);
        setResults([]);
        setHasSearched(true);
      } else {
        setResults(response.results);
        setShelfmarkUrl(response.shelfmark_url);
        setHasSearched(true);  // This triggers series enrichment useEffect
      }
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "Search failed");
      setResults([]);
      setHasSearched(true);
    }
  };

  // Handle clicking a series name to search for that series
  // Also prefills author field if author is known
  const handleSeriesClick = async (seriesNameToSearch: string, authorName?: string | null) => {
    // If already viewing this series search, just go back to results
    if (searchField === "series" && queryText === seriesNameToSearch && view !== "search") {
      handleBackToSearch();
      return;
    }
    
    // Skip search if same as last executed search
    if (lastSearch?.field === "series" && lastSearch?.query === seriesNameToSearch && hasSearched) {
      setSearchField("series");
      setView("search");
      return;
    }
    
    // Cancel any in-progress series enrichment
    enrichAbortRef.current?.abort();
    enrichAbortRef.current = null;
    
    // Clear releases/info state
    setSelectedBook(null);
    setBookInfo(null);
    setBookDetailFull(null);
    setReleases([]);
    setSources([]);
    setActiveSource(null);
    setReleasesError(null);
    setDownloadSuccess(null);
    setDownloadError(null);
    
    // Update state to search by series
    // Also prefill author field if known (helps user switch back to author search)
    setSearchField("series");
    setQueryTextByField(prev => ({
      ...prev,
      series: seriesNameToSearch,
      ...(authorName ? { author: authorName } : {}),
    }));
    setSearchError(null);
    setHasSearched(false);
    setSeriesEnrichProgress(null);
    setView("search");
    
    try {
      const response = await searchMutation.mutateAsync({
        series: seriesNameToSearch,
        media_type: "ebook",
      });

      if (response.error) {
        setSearchError(response.error);
        setResults([]);
        setHasSearched(true);
      } else {
        setResults(response.results);
        setShelfmarkUrl(response.shelfmark_url);
        setHasSearched(true);
        setLastSearch({ field: "series", query: seriesNameToSearch });
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
    // If already viewing this author search, just go back to results
    if (searchField === "author" && queryText === authorToSearch && view !== "search") {
      handleBackToSearch();
      return;
    }
    
    // Skip search if same as last executed search
    if (lastSearch?.field === "author" && lastSearch?.query === authorToSearch && hasSearched) {
      setSearchField("author");
      setView("search");
      return;
    }
    
    // Cancel any in-progress series enrichment
    enrichAbortRef.current?.abort();
    enrichAbortRef.current = null;
    
    // Clear releases/info state
    setSelectedBook(null);
    setBookInfo(null);
    setBookDetailFull(null);
    setReleases([]);
    setSources([]);
    setActiveSource(null);
    setReleasesError(null);
    setDownloadSuccess(null);
    setDownloadError(null);
    
    // Update state to search by author
    // Also prefill title and series fields if known
    setSearchField("author");
    setQueryTextByField(prev => ({
      ...prev,
      author: authorToSearch,
      ...(titleName ? { title: titleName } : {}),
      ...(seriesName ? { series: seriesName } : {}),
    }));
    setSearchError(null);
    setHasSearched(false);
    setSeriesEnrichProgress(null);
    setView("search");
    
    try {
      const response = await searchMutation.mutateAsync({
        author: authorToSearch,
        media_type: "ebook",
      });

      if (response.error) {
        setSearchError(response.error);
        setResults([]);
        setHasSearched(true);
      } else {
        setResults(response.results);
        setShelfmarkUrl(response.shelfmark_url);
        setHasSearched(true);
        setLastSearch({ field: "author", query: authorToSearch });
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
    // If already viewing this title search, just go back to results
    if (searchField === "title" && queryText === titleToSearch && view !== "search") {
      handleBackToSearch();
      return;
    }
    
    // Skip search if same as last executed search
    if (lastSearch?.field === "title" && lastSearch?.query === titleToSearch && hasSearched) {
      setSearchField("title");
      setView("search");
      return;
    }
    
    // Cancel any in-progress series enrichment
    enrichAbortRef.current?.abort();
    enrichAbortRef.current = null;
    
    // Clear releases/info state
    setSelectedBook(null);
    setBookInfo(null);
    setBookDetailFull(null);
    setReleases([]);
    setSources([]);
    setActiveSource(null);
    setReleasesError(null);
    setDownloadSuccess(null);
    setDownloadError(null);
    
    // Update state to search by title
    // Also prefill author and series fields if known
    setSearchField("title");
    setQueryTextByField(prev => ({
      ...prev,
      title: titleToSearch,
      ...(authorName ? { author: authorName } : {}),
      ...(seriesName ? { series: seriesName } : {}),
    }));
    setSearchError(null);
    setHasSearched(false);
    setSeriesEnrichProgress(null);
    setView("search");
    
    try {
      const response = await searchMutation.mutateAsync({
        title: titleToSearch,
        media_type: "ebook",
      });

      if (response.error) {
        setSearchError(response.error);
        setResults([]);
        setHasSearched(true);
      } else {
        setResults(response.results);
        setShelfmarkUrl(response.shelfmark_url);
        setHasSearched(true);
        setLastSearch({ field: "title", query: titleToSearch });
      }
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "Search failed");
      setResults([]);
      setHasSearched(true);
    }
  };

  const handleResultClick = async (result: ShelfmarkSearchResult) => {
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
    setBookDetailFull(null);

    // Determine provider from source display name
    let provider = "googlebooks"; // default
    const src = (result.source || "").toLowerCase();
    if (src.includes("google")) provider = "googlebooks";
    else if (src.includes("hardcover")) provider = "hardcover";
    else if (src.includes("openlibrary") || src.includes("open library")) provider = "openlibrary";

    // Fetch book details immediately (in parallel with releases)
    // This gives us description, series info etc. before releases finish loading
    bookDetailMutation.mutateAsync({ provider, bookId: result.id })
      .then(detail => setBookDetailFull(detail))
      .catch(err => console.error("Failed to fetch book details:", err));

    // Build manual query from search text (what user typed)
    const manualQuery = queryText.trim();

    try {
      // Build request params
      const requestParams: { provider: string; book_id: string; manual_query?: string } = {
        provider,
        book_id: result.id,
      };
      
      // If direct search is enabled, pass manual_query to override SM's metadata-based search
      if (directSearch && manualQuery) {
        requestParams.manual_query = manualQuery;
      }
      
      let response = await releasesMutation.mutateAsync(requestParams);
      
      // Preserve book info from first response (has correct metadata)
      const firstBookInfo = response.book;

      // Auto-retry with manual_query if no results and not already using direct search
      if (!directSearch && !response.error && response.releases.length === 0 && manualQuery) {
        // Retry with manual query
        response = await releasesMutation.mutateAsync({
          provider,
          book_id: result.id,
          manual_query: manualQuery,
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
    setBookDetailFull(null);
    setReleases([]);
    setSources([]);
    setActiveSource(null);
    setReleasesError(null);
    setDownloadSuccess(null);
    setDownloadError(null);
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
                <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Find Releases</div>
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
          <button
            type="button"
            onClick={onClose}
            className="ml-4 shrink-0 rounded-md border border-slate-600 bg-slate-800 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-700"
          >
            Close
          </button>
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
                    onChange={(e) => setSearchField(e.target.value as "general" | "author" | "title" | "series")}
                    className="rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  >
                    <option value="general">General</option>
                    <option value="author">Author</option>
                    <option value="title">Title</option>
                    <option value="series">Series</option>
                  </select>
                  <input
                    value={queryText}
                    onChange={(e) => setQueryText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && queryText.trim()) {
                        handleSearch();
                      }
                    }}
                    className="flex-1 rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-sm text-slate-100"
                    placeholder={
                      searchField === "author" ? "Author name..." :
                      searchField === "title" ? "Book title..." :
                      searchField === "series" ? "Series name..." :
                      "Author Name Book Title"
                    }
                  />
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="directSearch"
                    checked={directSearch}
                    onChange={(e) => setDirectSearch(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-600 bg-slate-700 text-emerald-600 focus:ring-emerald-500"
                  />
                  <label
                    htmlFor="directSearch"
                    className="text-xs text-slate-400 cursor-pointer"
                    title="Overrides metadata-based search with search query"
                  >
                    Direct search
                  </label>
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

              {/* Error message */}
              {searchError && (
                <div className="mt-4 rounded-xl border border-rose-500/30 bg-rose-500/10 p-4">
                  <div className="text-sm text-rose-300">{searchError}</div>
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
              {hasSearched && !searchMutation.isPending && !searchError && (
                <div className="mt-5 rounded-xl border border-slate-700 bg-slate-800 p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <div className="text-sm font-medium text-slate-100">Results</div>
                    <div className="flex items-center gap-3">
                      {results.length > 0 && (
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs text-slate-500">Sort:</span>
                          <select
                            value={sortBy}
                            onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                            className="rounded border border-slate-600 bg-slate-700 px-2 py-0.5 text-xs text-slate-200 focus:border-emerald-500 focus:outline-none"
                          >
                            <option value="default">Default</option>
                            <option value="series">Series</option>
                            <option value="title">Title</option>
                            <option value="year">Year</option>
                          </select>
                        </div>
                      )}
                      <div className="flex items-center gap-2 text-xs text-slate-500">
                        {seriesEnrichProgress && (
                          <span className="flex items-center gap-1.5 text-emerald-400">
                            <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
                            Caching {seriesEnrichProgress.current}/{seriesEnrichProgress.total}
                          </span>
                        )}
                        <span>{results.length} result{results.length !== 1 ? "s" : ""}</span>
                      </div>
                    </div>
                  </div>

                  {results.length === 0 ? (
                    <div className="text-sm text-slate-400">
                      No results found. Try adjusting your search query.
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-700 rounded-lg border border-slate-700 bg-slate-900/40">
                      {sortedResults.map((result, index) => (
                        <div
                          key={result.id || index}
                          className="flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-slate-800/60"
                        >
                          {/* Cover image with series position badge - clickable */}
                          <button
                            type="button"
                            onClick={() => handleResultClick(result)}
                            className="relative shrink-0"
                          >
                            {result.cover_url ? (
                              <img
                                src={result.cover_url}
                                alt=""
                                className="h-16 w-12 rounded border border-slate-600 object-cover bg-slate-800"
                                loading="lazy"
                                onError={(e) => {
                                  e.currentTarget.style.display = "none";
                                  e.currentTarget.nextElementSibling?.classList.remove("hidden");
                                }}
                              />
                            ) : null}
                            <div className={`flex h-16 w-12 items-center justify-center rounded border border-slate-600 bg-slate-800 text-[10px] text-slate-500 ${result.cover_url ? "hidden" : ""}`}>
                              No cover
                            </div>
                            {/* Series position badge */}
                            {result.series_position && (
                              <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-emerald-600 px-1 text-[10px] font-bold text-white">
                                #{result.series_position}
                              </span>
                            )}
                          </button>

                          {/* Main content - clickable to go to releases */}
                          <button
                            type="button"
                            onClick={() => handleResultClick(result)}
                            className="min-w-0 flex-1 text-left"
                          >
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleTitleClick(result.title, result.author, result.series_name);
                              }}
                              className="truncate text-sm font-medium text-slate-100 hover:text-emerald-300 hover:underline text-left"
                            >
                              {result.title}
                            </button>
                            {(result.author || result.series_name) && (
                              <div className="mt-0.5 truncate text-xs text-slate-400">
                                {result.author && (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleAuthorClick(result.author!, result.title, result.series_name);
                                    }}
                                    className="hover:text-emerald-300 hover:underline"
                                  >
                                    {result.author}
                                  </button>
                                )}
                                {result.author && result.series_name && result.series_position && " · "}
                                {result.series_name && result.series_position && (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleSeriesClick(result.series_name!, result.author);
                                    }}
                                    className="text-emerald-400 hover:text-emerald-300 hover:underline"
                                  >
                                    #{result.series_position}{result.series_count ? ` of ${result.series_count}` : ""} in {result.series_name}
                                  </button>
                                )}
                              </div>
                            )}
                            {/* Year and rating row */}
                            <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs text-slate-500">
                              {result.year && <span>{result.year}</span>}
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
                                setSelectedBook(result);
                                setView("info");
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
                              onClick={() => handleResultClick(result)}
                              className="rounded-full p-1.5 text-slate-500 hover:bg-slate-700 hover:text-emerald-400 transition-colors"
                              title="Find downloads"
                            >
                              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                                />
                              </svg>
                            </button>
                          </div>
                        </div>
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

              {/* Book info content */}
              <div className="flex flex-col gap-6 lg:flex-row lg:gap-8">
                {/* Cover - larger sizing like SM */}
                <div className="flex justify-center lg:justify-start lg:self-start">
                  {(bookDetailFull?.cover_url || selectedBook.cover_url) ? (
                    <img
                      src={bookDetailFull?.cover_url || selectedBook.cover_url || ""}
                      alt=""
                      className="max-h-[60vh] w-auto max-w-[432px] rounded-xl border border-slate-600 object-contain bg-slate-800 shadow-lg"
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                        e.currentTarget.nextElementSibling?.classList.remove("hidden");
                      }}
                    />
                  ) : null}
                  <div className={`flex h-64 w-44 items-center justify-center rounded-xl border border-dashed border-slate-600 bg-slate-800/60 text-sm text-slate-500 ${(bookDetailFull?.cover_url || selectedBook.cover_url) ? "hidden" : ""}`}>
                    No cover
                  </div>
                </div>

                {/* Metadata - compact layout */}
                <div className="flex-1 space-y-3">
                  {/* Loading indicator */}
                  {detailLoading && !bookDetailFull && (
                    <div className="flex items-center gap-2 text-sm text-slate-400">
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" />
                      Loading details...
                    </div>
                  )}

                  {/* Top row: Year, Rating, Readers - inline */}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-300">
                    {(bookDetailFull?.year || selectedBook.year) && (
                      <span>{bookDetailFull?.year || selectedBook.year}</span>
                    )}
                    {(() => {
                      const ratingField = bookDetailFull?.display_fields?.find(f => f.icon === "star") 
                        || selectedBook.display_fields?.find(f => f.icon === "star");
                      return ratingField ? (
                        <span className="flex items-center gap-1">
                          <span className="text-amber-400">★</span>
                          <span>{ratingField.value}</span>
                          <span className="text-slate-500">{ratingField.label}</span>
                        </span>
                      ) : null;
                    })()}
                    {(() => {
                      const readersField = bookDetailFull?.display_fields?.find(f => f.icon === "users")
                        || selectedBook.display_fields?.find(f => f.icon === "users");
                      return readersField ? (
                        <span className="flex items-center gap-1">
                          <svg className="h-4 w-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z" />
                          </svg>
                          <span>{readersField.value}</span>
                          <span className="text-slate-500">{readersField.label}</span>
                        </span>
                      ) : null;
                    })()}
                  </div>

                  {/* Series line - green, prominent, clickable */}
                  {(bookDetailFull?.series_name || selectedBook.series_name) && (
                    <button
                      type="button"
                      onClick={() => handleSeriesClick(
                        bookDetailFull?.series_name || selectedBook.series_name!,
                        bookDetailFull?.author || selectedBook.author
                      )}
                      className="text-sm font-medium text-emerald-400 hover:text-emerald-300 hover:underline text-left"
                    >
                      {(() => {
                        const seriesName = bookDetailFull?.series_name || selectedBook.series_name;
                        const seriesPosition = bookDetailFull?.series_position ?? selectedBook.series_position;
                        const seriesCount = bookDetailFull?.series_count ?? selectedBook.series_count;
                        if (seriesPosition != null) {
                          return (
                            <>#{seriesPosition}{seriesCount ? ` of ${seriesCount}` : ""} in {seriesName}</>
                          );
                        }
                        return seriesName;
                      })()}
                    </button>
                  )}

                  {/* Description - in a scrollable styled text box */}
                  {(bookDetailFull?.description || selectedBook.description) && (
                    <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4 max-h-[480px] overflow-y-auto">
                      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">Description</div>
                      <div className="text-sm text-slate-300 leading-relaxed whitespace-pre-line">
                        {stripHtml(bookDetailFull?.description || selectedBook.description)}
                      </div>
                    </div>
                  )}

                  {/* Bottom row: ISBN and View on HC - inline */}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                    {(bookDetailFull?.isbn || selectedBook.isbn) && (
                      <span className="text-slate-400">
                        ISBN: <span className="font-mono text-slate-300">{bookDetailFull?.isbn || selectedBook.isbn}</span>
                      </span>
                    )}
                    {(bookDetailFull?.source_url || selectedBook.source_url) && (
                      <a
                        href={bookDetailFull?.source_url || selectedBook.source_url || ""}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-emerald-400 hover:text-emerald-300 transition-colors"
                      >
                        View on {bookDetailFull?.provider_display_name || (() => {
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

              {/* Book info header */}
              {(bookInfo || selectedBook) && (
                <div className="mb-5 rounded-xl border border-slate-700 bg-slate-800 p-4">
                  <div className="flex gap-4">
                    {/* Cover */}
                    {(bookDetailFull?.cover_url || bookInfo?.cover_url || selectedBook?.cover_url) ? (
                      <img
                        src={bookDetailFull?.cover_url || bookInfo?.cover_url || selectedBook?.cover_url || ""}
                        alt=""
                        className="h-32 w-24 shrink-0 rounded border border-slate-600 object-cover bg-slate-700"
                        onError={(e) => {
                          e.currentTarget.style.display = "none";
                          e.currentTarget.nextElementSibling?.classList.remove("hidden");
                        }}
                      />
                    ) : null}
                    <div className={`flex h-32 w-24 shrink-0 items-center justify-center rounded border border-slate-600 bg-slate-700 text-xs text-slate-500 ${(bookDetailFull?.cover_url || bookInfo?.cover_url || selectedBook?.cover_url) ? "hidden" : ""}`}>
                      No cover
                    </div>

                    {/* Info */}
                    <div className="min-w-0 flex-1">
                      {/* Year and display fields (rating, readers) */}
                      <div className="flex flex-wrap items-center gap-3 text-sm text-slate-400">
                        {(bookDetailFull?.year || bookInfo?.year || selectedBook?.year) && (
                          <span>{bookDetailFull?.year || bookInfo?.year || selectedBook?.year}</span>
                        )}
                        {/* Display fields - prefer full details */}
                        {(bookDetailFull?.display_fields || selectedBook?.display_fields || []).map((field, idx) => (
                          <span key={idx} className="flex items-center gap-1">
                            {field.icon === "star" && <span className="text-amber-400">★</span>}
                            {field.icon === "users" && <span>👥</span>}
                            <span>{field.value}</span>
                            {field.label && <span className="text-slate-500">{field.label}</span>}
                          </span>
                        ))}
                      </div>
                      
                      {/* Series info - prefer full details (has series_count) */}
                      {(bookDetailFull?.series_name || bookInfo?.series_name || selectedBook?.series_name) && (
                        <button
                          type="button"
                          onClick={() => handleSeriesClick(
                            bookDetailFull?.series_name || bookInfo?.series_name || selectedBook?.series_name!,
                            bookDetailFull?.author || bookInfo?.author || selectedBook?.author
                          )}
                          className="mt-1 text-sm text-emerald-400 hover:text-emerald-300 hover:underline text-left"
                        >
                          #{bookDetailFull?.series_position ?? bookInfo?.series_position ?? selectedBook?.series_position ?? "?"}
                          {bookDetailFull?.series_count ? ` of ${bookDetailFull.series_count}` : ""} in {bookDetailFull?.series_name || bookInfo?.series_name || selectedBook?.series_name}
                        </button>
                      )}
                      
                      {/* Description with expand/collapse - prefer full details */}
                      {(bookDetailFull?.description || bookInfo?.description || selectedBook?.description) && (
                        <div className="mt-2">
                          <p className={`text-sm text-slate-300 whitespace-pre-line ${descriptionExpanded ? "" : "line-clamp-3"}`}>
                            {stripHtml(bookDetailFull?.description || bookInfo?.description || selectedBook?.description)}
                          </p>
                          {((stripHtml(bookDetailFull?.description || bookInfo?.description || selectedBook?.description) || "").length > 200) && (
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
                      
                      {/* ISBN and source link */}
                      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
                        {(bookDetailFull?.isbn || bookInfo?.isbn || selectedBook?.isbn) && (
                          <span className="text-slate-500">ISBN: {bookDetailFull?.isbn || bookInfo?.isbn || selectedBook?.isbn}</span>
                        )}
                        {(bookDetailFull?.source_url || bookInfo?.source_url || selectedBook?.source_url) && (
                          <a
                            href={bookDetailFull?.source_url || bookInfo?.source_url || selectedBook?.source_url || ""}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-emerald-400 hover:text-emerald-300"
                          >
                            View on {bookDetailFull?.provider_display_name || (() => {
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
              )}

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
              Find Downloads
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
