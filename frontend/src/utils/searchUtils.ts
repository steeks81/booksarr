/**
 * Search-related utilities
 */

import type { ShelfmarkSearchResult } from '../api/shelfmark';

/**
 * Normalize ISBN: strip hyphens and spaces, lowercase
 */
export function normalizeIsbn(isbn: string): string {
  return isbn.replace(/[-\s]/g, '').toLowerCase();
}

/**
 * Strip HTML tags and convert paragraph breaks to newlines
 */
export function stripHtml(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<\/p>\s*<p>/gi, '\n\n') // Convert </p><p> to double newline
    .replace(/<br\s*\/?>/gi, '\n') // Convert <br> to newline
    .replace(/<[^>]+>/g, '') // Strip remaining HTML tags
    .trim();
}

/**
 * Sanitize search results: trim whitespace and add stable React keys
 * Handles potential duplicate provider:id combinations
 */
let resultKeyCounter = 0;

export interface SanitizedSearchResult extends ShelfmarkSearchResult {
  _key: string;
}

export function sanitizeResults(results: ShelfmarkSearchResult[]): SanitizedSearchResult[] {
  return results.map((r) => ({
    ...r,
    title: r.title?.trim() || r.title,
    author: r.author?.trim() || r.author,
    series_name: r.series_name?.trim() || r.series_name,
    _key: `${r.provider}:${r.id}:${++resultKeyCounter}`,
  }));
}

/**
 * Reset the key counter (useful for tests or when results are completely replaced)
 */
export function resetResultKeyCounter() {
  resultKeyCounter = 0;
}
