/**
 * Smart Bulk Mode - Groups selected books intelligently for bulk search
 * 
 * Algorithm:
 * 1. Group books by series (from BA database)
 * 2. For each series group: if ≥2 books AND ≥30% of series → series search
 * 3. Books not meeting threshold → individual title search
 * 4. Order: position of first occurrence of each group
 */

import type { BulkBook } from '../components/activity/ActivityOverlay';
import type { BookInAuthor } from '../types';

interface SeriesGroup {
  seriesId: number;
  seriesName: string;
  seriesHardcoverId: number | null;
  seriesCount: number; // Total books in series
  books: BookInAuthor[];
  firstIndex: number; // Position of first book in original selection
}

/**
 * Determine ownership filter based on selected books
 */
function determineOwnershipFilter(books: BookInAuthor[]): 'all' | 'missing' | 'owned' {
  const allOwned = books.every(b => b.is_owned);
  const allMissing = books.every(b => !b.is_owned);
  
  if (allMissing) return 'missing';
  if (allOwned) return 'owned';
  return 'all';
}

/**
 * Transform selected books into smart bulk steps
 */
export function createSmartBulkSteps(
  selectedBooks: BookInAuthor[],
  authorName: string | null,
  authorId: number | null,
  authorHardcoverId: number | null
): BulkBook[] {
  if (selectedBooks.length === 0) return [];
  
  // Single book - no grouping needed
  if (selectedBooks.length === 1) {
    const book = selectedBooks[0];
    return [{
      id: String(book.id),
      title: book.title,
      authorName,
      authorId,
      authorHardcoverId,
      _ownershipFilter: book.is_owned ? 'owned' : 'missing',
    }];
  }
  
  // Group books by series
  const seriesGroups = new Map<number, SeriesGroup>();
  const standaloneBooks: { book: BookInAuthor; index: number }[] = [];
  
  selectedBooks.forEach((book, index) => {
    // Get primary series (first one with valid id)
    const primarySeries = book.series_info?.find(s => s.id != null);
    
    if (primarySeries?.id) {
      const seriesId = primarySeries.id;
      
      if (seriesGroups.has(seriesId)) {
        seriesGroups.get(seriesId)!.books.push(book);
      } else {
        seriesGroups.set(seriesId, {
          seriesId,
          seriesName: primarySeries.series_name || 'Unknown Series',
          seriesHardcoverId: primarySeries.provider_id ? parseInt(primarySeries.provider_id, 10) : null,
          seriesCount: primarySeries.series_count || 0,
          books: [book],
          firstIndex: index,
        });
      }
    } else {
      standaloneBooks.push({ book, index });
    }
  });
  
  // Build steps array with proper ordering
  type StepEntry = 
    | { type: 'series'; group: SeriesGroup; index: number }
    | { type: 'title'; book: BookInAuthor; index: number };
  
  const steps: StepEntry[] = [];
  
  // Add series groups (check threshold)
  for (const group of seriesGroups.values()) {
    const meetsCountThreshold = group.books.length >= 2;
    const meetsPercentThreshold = group.seriesCount > 0 
      ? (group.books.length / group.seriesCount) >= 0.3 
      : true; // If no series count, allow if ≥2 books
    
    if (meetsCountThreshold && meetsPercentThreshold) {
      // Series search
      steps.push({ type: 'series', group, index: group.firstIndex });
    } else {
      // Individual title searches for each book in this series
      group.books.forEach((book, i) => {
        // Find original index of this book
        const originalIndex = selectedBooks.findIndex(b => b.id === book.id);
        steps.push({ type: 'title', book, index: originalIndex });
      });
    }
  }
  
  // Add standalone books
  for (const { book, index } of standaloneBooks) {
    steps.push({ type: 'title', book, index });
  }
  
  // Sort by original index (first occurrence)
  steps.sort((a, b) => a.index - b.index);
  
  // Convert to BulkBook array
  return steps.map((step): BulkBook => {
    if (step.type === 'series') {
      const group = step.group;
      return {
        id: `series-${group.seriesId}`,
        title: group.seriesName,
        authorName,
        authorId,
        authorHardcoverId,
        seriesName: group.seriesName,
        seriesHardcoverId: group.seriesHardcoverId,
        _searchField: 'series',
        _ownershipFilter: determineOwnershipFilter(group.books),
        _isSeriesSearch: true,
        _seriesBookCount: group.books.length,
      };
    } else {
      const book = step.book;
      const primarySeries = book.series_info?.find(s => s.id != null);
      return {
        id: String(book.id),
        title: book.title,
        authorName,
        authorId,
        authorHardcoverId,
        seriesName: primarySeries?.series_name ?? null,
        seriesHardcoverId: primarySeries?.provider_id ? parseInt(primarySeries.provider_id, 10) : null,
        _ownershipFilter: book.is_owned ? 'owned' : 'missing',
      };
    }
  });
}
