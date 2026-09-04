import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchApi } from "./client";

export interface ShelfmarkDisplayField {
  label: string;
  value: string;
  icon: string | null;
}

export interface ShelfmarkSearchResult {
  id: string;
  title: string;
  author: string | null;
  format: string | null;
  size: string | null;
  source: string | null;  // Display name (e.g., "Google Books", "Hardcover")
  provider: string | null;  // Provider code (e.g., "googlebooks", "hardcover")
  download_url: string | null;
  cover_url: string | null;
  // Additional metadata fields
  year: number | null;
  description: string | null;
  source_url: string | null;
  isbn: string | null;
  // Series info
  series_id: string | null;  // Provider-specific series ID (e.g., HC series id)
  series_name: string | null;
  series_position: number | null;
  series_count: number | null;
  // Display fields (rating, readers, etc.)
  display_fields: ShelfmarkDisplayField[] | null;
}

export interface ShelfmarkSearchResponse {
  query: string;
  results: ShelfmarkSearchResult[];
  total_results: number;
  shelfmark_url: string | null;
  error: string | null;
}

export interface ShelfmarkConnectionResponse {
  connected: boolean;
  url: string | null;
  error: string | null;
}

export function useShelfmarkSearch() {
  return useMutation({
    mutationFn: (body: { query?: string; media_type?: "ebook" | "audiobook"; series?: string; author?: string; title?: string; isbn?: string; author_hardcover_id?: number | null; series_hardcover_id?: number | null }) =>
      fetchApi<ShelfmarkSearchResponse>("/shelfmark/search", {
        method: "POST",
        body: JSON.stringify(body),
      }),
  });
}

// --- Series Enrichment SSE API ---

export interface SeriesEnrichEvent {
  type: "progress" | "series" | "done" | "error";
  current?: number;
  total?: number;
  book_id?: string;
  series_name?: string | null;
  series_position?: number | null;
  series_count?: number | null;
  message?: string;  // Error message
  errors?: number;   // Count of errors (in done event)
  skipped?: number;  // Count of skipped books (in done event)
}

/**
 * Fetch series info for a list of books via Server-Sent Events.
 * Returns an async generator that yields progress and series events.
 * Pass an AbortSignal to cancel the stream.
 */
export async function* enrichSeriesStream(
  books: Array<{ provider: string; book_id: string }>,
  signal?: AbortSignal
): AsyncGenerator<SeriesEnrichEvent> {
  const response = await fetch("/api/shelfmark/search/enrich-series", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ books }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch series info: ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No response body");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      // Check for abort before each read
      if (signal?.aborted) {
        reader.cancel();
        return;
      }
      
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      
      // Parse SSE events from buffer
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const event = JSON.parse(line.slice(6)) as SeriesEnrichEvent;
            yield event;
          } catch {
            // Ignore parse errors
          }
        }
      }
    }
  } finally {
    reader.cancel();
  }
}

export function useShelfmarkTestConnection(enabled: boolean = false) {
  return useQuery({
    queryKey: ["shelfmarkConnection"],
    queryFn: () => fetchApi<ShelfmarkConnectionResponse>("/shelfmark/test"),
    enabled,
    staleTime: 30000,
  });
}

// --- Releases and Download API ---

export interface ShelfmarkBookInfo {
  title: string;
  author: string | null;
  description: string | null;
  cover_url: string | null;
  year: number | null;
  isbn: string | null;
  source_url: string | null;
  provider: string | null;
  provider_id: string | null;
  // Series info
  series_id: string | null;
  series_name: string | null;
  series_position: number | null;
}

export interface ShelfmarkRelease {
  source: string;
  source_id: string;
  title: string;
  author: string | null;
  format: string | null;
  size: string | null;
  language: string | null;
  indexer: string | null;
  cover_url: string | null;
  info_url: string | null;
}

export interface ShelfmarkReleasesResponse {
  book: ShelfmarkBookInfo | null;
  releases: ShelfmarkRelease[];
  sources: string[];
  error: string | null;
}

export interface ShelfmarkDownloadResponse {
  success: boolean;
  status: string | null;
  priority: number | null;
  error: string | null;
}

export function useShelfmarkReleases() {
  return useMutation({
    mutationFn: (body: { provider: string; book_id: string; manual_query?: string }) =>
      fetchApi<ShelfmarkReleasesResponse>("/shelfmark/releases", {
        method: "POST",
        body: JSON.stringify(body),
      }),
  });
}

// --- Book Detail API ---

export interface ShelfmarkBookDetailResponse {
  id: string;
  title: string;
  author: string | null;
  description: string | null;
  cover_url: string | null;
  year: number | null;
  isbn: string | null;
  source_url: string | null;
  provider: string | null;
  provider_display_name: string | null;
  // Series info
  series_id: string | null;
  series_name: string | null;
  series_position: number | null;
  series_count: number | null;
  // Additional metadata
  genres: string[] | null;
  publisher: string | null;
  language: string | null;
  // Display fields (rating, readers, etc.)
  display_fields: ShelfmarkDisplayField[] | null;
  error: string | null;
}

export function useShelfmarkBookDetail() {
  return useMutation({
    mutationFn: ({ provider, bookId }: { provider: string; bookId: string }) =>
      fetchApi<ShelfmarkBookDetailResponse>(`/shelfmark/book/${encodeURIComponent(provider)}/${encodeURIComponent(bookId)}`),
  });
}

export function useShelfmarkDownload() {
  return useMutation({
    mutationFn: (body: {
      source: string;
      source_id: string;
      // Release metadata
      title?: string;
      author?: string;
      format?: string;
      size?: string;
      cover_url?: string;
      // Book metadata
      book_title?: string;
      book_author?: string;
      book_year?: number;
      book_provider?: string;
      book_provider_id?: string;
      // Series metadata
      series_name?: string;
      series_position?: number;
    }) =>
      fetchApi<ShelfmarkDownloadResponse>("/shelfmark/download", {
        method: "POST",
        body: JSON.stringify(body),
      }),
  });
}


// --- Download Status API ---

export interface ShelfmarkDownloadStatus {
  source_id: string;
  title: string;
  author: string | null;
  status: string;
  status_message: string | null;
  progress: number;
  source: string;
  source_display_name: string | null;
  format: string | null;
  size: string | null;
  cover_url: string | null;
}

export interface ShelfmarkStatusResponse {
  in_progress: ShelfmarkDownloadStatus[];
  complete: ShelfmarkDownloadStatus[];
  failed: ShelfmarkDownloadStatus[];
  error: string | null;
}

export function useShelfmarkStatus(enabled: boolean = true, refetchInterval: number = 2000) {
  return useQuery({
    queryKey: ["shelfmarkStatus"],
    queryFn: () => fetchApi<ShelfmarkStatusResponse>("/shelfmark/status"),
    enabled,
    refetchInterval: enabled ? refetchInterval : false,
  });
}


// --- Cancel Download API ---

export interface ShelfmarkCancelResponse {
  success: boolean;
  error: string | null;
}

export function useShelfmarkCancel() {
  return useMutation({
    mutationFn: (source_id: string) =>
      fetchApi<ShelfmarkCancelResponse>(`/shelfmark/download/${encodeURIComponent(source_id)}`, {
        method: "DELETE",
      }),
  });
}


// --- Retry Download API ---

export interface ShelfmarkRetryResponse {
  success: boolean;
  error: string | null;
}

export function useShelfmarkRetry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (source_id: string) =>
      fetchApi<ShelfmarkRetryResponse>(`/shelfmark/download/${encodeURIComponent(source_id)}/retry`, {
        method: "POST",
      }),
    onSuccess: () => {
      // Refetch status to see the retried download
      queryClient.invalidateQueries({ queryKey: ["shelfmarkStatus"] });
    },
  });
}


// --- Dismiss Downloads API ---

export interface ShelfmarkDismissResponse {
  success: boolean;
  error: string | null;
}

export function useShelfmarkDismiss() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (source_ids: string[]) =>
      fetchApi<ShelfmarkDismissResponse>("/shelfmark/dismiss", {
        method: "POST",
        body: JSON.stringify({ source_ids }),
      }),
    onSuccess: () => {
      // Refetch status to update the lists
      queryClient.invalidateQueries({ queryKey: ["shelfmarkStatus"] });
    },
  });
}


// --- Series Prefetch API ---

export interface SeriesPrefetchResponse {
  status: string;
  cache_hits: number;
  to_fetch: number;
}

// --- Background Series Enrichment API (single shared worker + polling) ---

export interface EnrichSeriesStartResponse {
  already_cached: number;
  queued: number;
  queue_size: number;
}

export interface EnrichSeriesSeriesInfo {
  series_id: string | null;
  series_name: string | null;
  series_position: number | null;
  series_count: number | null;
  isbn: string | null;
}

export interface EnrichSeriesStatusResponse {
  done: number;
  total: number;
  series: Record<string, EnrichSeriesSeriesInfo>;  // book_id -> series info (cached)
  worker_running: boolean;
  rate_limited: boolean;
  message: string | null;
}

/**
 * Queue books for background series enrichment (single shared worker).
 * Returns immediately. New books are prepended (current search prioritized) and
 * deduped against cache + queue. Poll getEnrichSeriesStatus() for progress.
 */
export async function startEnrichSeries(
  books: Array<{ provider: string; book_id: string }>,
): Promise<EnrichSeriesStartResponse> {
  return fetchApi<EnrichSeriesStartResponse>("/shelfmark/search/enrich-series/start", {
    method: "POST",
    body: JSON.stringify({ books }),
  });
}

/**
 * Get enrichment status for a specific set of books (the current search).
 * Returns which of those books are cached (with series data) + global worker state.
 */
export async function getEnrichSeriesStatus(
  books: Array<{ provider: string; book_id: string }>,
): Promise<EnrichSeriesStatusResponse> {
  return fetchApi<EnrichSeriesStatusResponse>("/shelfmark/search/enrich-series/status", {
    method: "POST",
    body: JSON.stringify({ books }),
  });
}

/**
 * Prefetch series info for a list of books.
 * This warms the backend cache so subsequent enrichment is instant.
 * 
 * The actual fetching happens via the SSE stream endpoint.
 */
export async function prefetchSeries(
  books: Array<{ provider: string; book_id: string }>,
): Promise<SeriesPrefetchResponse> {
  return fetchApi<SeriesPrefetchResponse>("/shelfmark/series/prefetch", {
    method: "POST",
    body: JSON.stringify({ books }),
  });
}

/**
 * Prefetch series info via Server-Sent Events.
 * This is a fire-and-forget background operation - results are cached in backend.
 * 
 * @param books List of books to prefetch
 * @param signal Optional AbortSignal to cancel the prefetch
 * @param onProgress Optional callback for progress updates
 */
export async function prefetchSeriesStream(
  books: Array<{ provider: string; book_id: string }>,
  signal?: AbortSignal,
  onProgress?: (current: number, total: number) => void,
): Promise<boolean> {
  const response = await fetch("/api/shelfmark/series/prefetch-stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ books }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Failed to prefetch series: ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No response body");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let receivedDone = false;

  try {
    while (true) {
      if (signal?.aborted) {
        reader.cancel();
        return false;
      }
      
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      
      // Parse SSE events from buffer
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === "progress" && onProgress) {
              onProgress(event.current, event.total);
            } else if (event.type === "done") {
              receivedDone = true;
            }
            // Ignore "ping" events - they're just keepalives
          } catch {
            // Ignore parse errors
          }
        }
      }
    }
  } finally {
    reader.cancel();
  }
  
  return receivedDone;
}
