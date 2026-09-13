/**
 * useVisibilityEnrichment - Hook for visibility-based series enrichment
 * 
 * Instead of enriching all search results at once, this queues books for
 * enrichment as they scroll into view. More efficient for large result sets.
 * 
 * Usage:
 *   const { enrichedBooks, enrichmentStatus, handleRowVisible } = useVisibilityEnrichment();
 *   <SearchResultsList onVisible={handleRowVisible} enrichedBooks={enrichedBooks} ... />
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { startEnrichSeries, getEnrichSeriesStatus } from '../api/shelfmark';
import type { ShelfmarkSearchResult } from '../api/shelfmark';

export interface EnrichedData {
  series_name: string | null;
  series_position: number | null;
  series_count: number | null;
  isbn: string | null;
  enriched_at: number;
}

export interface EnrichmentStatus {
  done: number;
  total: number;
  isRunning: boolean;
  error: string | null;
  rateLimited: boolean;
}

interface UseVisibilityEnrichmentResult {
  enrichedBooks: Map<string, EnrichedData>;
  enrichmentStatus: EnrichmentStatus;
  handleRowVisible: (result: ShelfmarkSearchResult) => void;
  clearEnrichment: () => void;
}

// Batch delay - wait this long to collect visible rows before sending to backend
const BATCH_DELAY_MS = 300;
// Poll interval for checking enrichment status
const POLL_INTERVAL_MS = 1000;
// UI update batching - only update enrichedBooks state this often to reduce re-renders
const UI_UPDATE_INTERVAL_MS = 2000;

export function useVisibilityEnrichment(): UseVisibilityEnrichmentResult {
  // Cache of enriched books: "provider:bookId" -> EnrichedData
  const [enrichedBooks, setEnrichedBooks] = useState<Map<string, EnrichedData>>(new Map());
  
  // Pending enrichment updates (batched before applying to state)
  const pendingEnrichmentsRef = useRef<Map<string, EnrichedData>>(new Map());
  const lastUiUpdateRef = useRef<number>(0);
  
  // Enrichment status for UI
  const [enrichmentStatus, setEnrichmentStatus] = useState<EnrichmentStatus>({
    done: 0,
    total: 0,
    isRunning: false,
    error: null,
    rateLimited: false,
  });
  
  // Queue of books waiting to be sent to backend
  const pendingQueueRef = useRef<Array<{ provider: string; book_id: string }>>([]);
  // Books currently being enriched (sent to backend, waiting for results)
  const activeQueueRef = useRef<Array<{ provider: string; book_id: string }>>([]);
  // Set of book IDs we've already queued (to avoid duplicates)
  const queuedIdsRef = useRef<Set<string>>(new Set());
  // Batch timer
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Poll timer
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Flush pending enrichments to state (batched to reduce re-renders)
  const flushPendingEnrichments = useCallback(() => {
    if (pendingEnrichmentsRef.current.size === 0) return;
    
    const pending = pendingEnrichmentsRef.current;
    pendingEnrichmentsRef.current = new Map();
    lastUiUpdateRef.current = Date.now();
    
    setEnrichedBooks(prev => {
      const next = new Map(prev);
      for (const [key, data] of pending) {
        next.set(key, data);
      }
      return next;
    });
  }, []);

  // Send pending queue to backend
  const flushQueue = useCallback(async () => {
    if (pendingQueueRef.current.length === 0) return;
    
    const booksToEnrich = [...pendingQueueRef.current];
    pendingQueueRef.current = [];
    
    // Add to active queue
    activeQueueRef.current = [...activeQueueRef.current, ...booksToEnrich];
    
    setEnrichmentStatus(prev => ({
      ...prev,
      total: prev.total + booksToEnrich.length,
      isRunning: true,
      error: null,
    }));
    
    try {
      await startEnrichSeries(booksToEnrich);
    } catch (err) {
      setEnrichmentStatus(prev => ({
        ...prev,
        error: err instanceof Error ? err.message : 'Enrichment failed',
      }));
    }
  }, []);

  // Handle row becoming visible
  const handleRowVisible = useCallback((result: ShelfmarkSearchResult) => {
    // Skip if no provider or ID
    if (!result.provider || !result.id) return;
    
    const cacheKey = `${result.provider}:${result.id}`;
    
    // Skip if already enriched or queued
    if (enrichedBooks.has(cacheKey) || queuedIdsRef.current.has(cacheKey)) return;
    
    // Skip if no series hint - these books likely won't have series data
    if (!result.series_name) return;
    
    // Skip if already has series position (already has data)
    if (result.series_position !== null) return;
    
    // Add to queue
    queuedIdsRef.current.add(cacheKey);
    pendingQueueRef.current.push({ provider: result.provider, book_id: result.id });
    
    // Debounce: wait for more rows before sending
    if (batchTimerRef.current) {
      clearTimeout(batchTimerRef.current);
    }
    batchTimerRef.current = setTimeout(() => {
      flushQueue();
    }, BATCH_DELAY_MS);
  }, [enrichedBooks, flushQueue]);

  // Poll for enrichment results
  useEffect(() => {
    // Start polling when we have active enrichments
    if (activeQueueRef.current.length > 0 && !pollTimerRef.current) {
      pollTimerRef.current = setInterval(async () => {
        if (activeQueueRef.current.length === 0) {
          if (pollTimerRef.current) {
            clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
          }
          return;
        }
        
        try {
          const status = await getEnrichSeriesStatus(activeQueueRef.current);
          
          // Batch enrichment updates to reduce re-renders
          if (Object.keys(status.series).length > 0) {
            const enrichedAt = Date.now();
            for (const [bookId, info] of Object.entries(status.series)) {
              // Find the provider for this book
              const book = activeQueueRef.current.find(b => b.book_id === bookId);
              if (book) {
                pendingEnrichmentsRef.current.set(`${book.provider}:${bookId}`, {
                  series_name: info.series_name,
                  series_position: info.series_position,
                  series_count: info.series_count,
                  isbn: info.isbn,
                  enriched_at: enrichedAt,
                });
              }
            }
            
            // Only flush to state every UI_UPDATE_INTERVAL_MS to reduce re-renders
            const now = Date.now();
            const shouldFlush = now - lastUiUpdateRef.current >= UI_UPDATE_INTERVAL_MS;
            const isDone = !status.worker_running || status.done >= status.total;
            
            if (shouldFlush || isDone) {
              flushPendingEnrichments();
            }
          }
          
          // Update status
          setEnrichmentStatus(prev => ({
            ...prev,
            done: status.done,
            isRunning: status.worker_running,
            rateLimited: status.rate_limited,
          }));
          
          // Stop polling when done
          if (!status.worker_running || status.done >= status.total) {
            // Remove completed books from active queue
            const completedIds = new Set(Object.keys(status.series));
            activeQueueRef.current = activeQueueRef.current.filter(
              b => !completedIds.has(b.book_id)
            );
            
            if (activeQueueRef.current.length === 0) {
              if (pollTimerRef.current) {
                clearInterval(pollTimerRef.current);
                pollTimerRef.current = null;
              }
              setEnrichmentStatus(prev => ({ ...prev, isRunning: false }));
            }
          }
        } catch (err) {
          setEnrichmentStatus(prev => ({
            ...prev,
            error: err instanceof Error ? err.message : 'Status check failed',
          }));
        }
      }, POLL_INTERVAL_MS);
    }
    
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [enrichmentStatus.isRunning, flushPendingEnrichments]);

  // Clear all enrichment state
  const clearEnrichment = useCallback(() => {
    if (batchTimerRef.current) {
      clearTimeout(batchTimerRef.current);
      batchTimerRef.current = null;
    }
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    pendingQueueRef.current = [];
    activeQueueRef.current = [];
    queuedIdsRef.current.clear();
    pendingEnrichmentsRef.current.clear();
    lastUiUpdateRef.current = 0;
    setEnrichedBooks(new Map());
    setEnrichmentStatus({ done: 0, total: 0, isRunning: false, error: null, rateLimited: false });
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (batchTimerRef.current) clearTimeout(batchTimerRef.current);
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

  return {
    enrichedBooks,
    enrichmentStatus,
    handleRowVisible,
    clearEnrichment,
  };
}
