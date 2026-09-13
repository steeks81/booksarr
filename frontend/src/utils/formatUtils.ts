/**
 * Format and language badge color utilities
 */

/**
 * Get badge background color for language code
 */
export function getLanguageBadgeColor(lang: string | null): string {
  if (!lang) return 'bg-slate-600';
  const l = lang.toLowerCase();
  if (l === 'en' || l === 'english') return 'bg-emerald-600';
  if (l === 'es' || l === 'spanish') return 'bg-amber-600';
  if (l === 'de' || l === 'german') return 'bg-rose-600';
  if (l === 'fr' || l === 'french') return 'bg-blue-600';
  return 'bg-slate-600';
}

/**
 * Get badge background color for file format
 */
export function getFormatBadgeColor(format: string | null): string {
  if (!format) return 'bg-slate-600';
  const f = format.toLowerCase();
  if (f === 'epub') return 'bg-emerald-600';
  if (f === 'pdf') return 'bg-rose-600';
  if (f === 'mobi' || f === 'azw3') return 'bg-amber-600';
  if (f === 'cbz' || f === 'cbr') return 'bg-purple-600';
  return 'bg-slate-600';
}

/**
 * Source display names (matching SM)
 */
const SOURCE_DISPLAY_NAMES: Record<string, string> = {
  direct_download: 'Direct Download',
  prowlarr: 'Prowlarr',
  irc: 'IRC',
  usenet: 'Usenet',
  torrent: 'Torrent',
};

/**
 * Get human-readable display name for download source
 */
export function getSourceDisplayName(source: string): string {
  return (
    SOURCE_DISPLAY_NAMES[source] ||
    source.charAt(0).toUpperCase() + source.slice(1).replace(/_/g, ' ')
  );
}

/**
 * Decode Shelfmark proxy cover URL to get the real URL.
 * SM cover URLs like /api/covers/proxy?url=<base64> contain the original URL
 * (usually from Hardcover) encoded in base64. We decode to avoid auth issues.
 */
export function decodeShelfmarkCoverUrl(coverUrl: string | null | undefined): string | null {
  if (!coverUrl) return null;
  
  // Check if it's a SM proxy URL
  if (coverUrl.includes('/api/covers/')) {
    try {
      const urlParam = new URL(coverUrl).searchParams.get('url');
      if (urlParam) {
        // SM uses URL-safe base64 (- and _ instead of + and /)
        return atob(urlParam.replace(/-/g, '+').replace(/_/g, '/'));
      }
    } catch {
      // Failed to decode, return original
    }
  }
  
  return coverUrl;
}


/**
 * Get the best available cover URL for a search result.
 * Priority: owned book cover (from our DB) > decoded SM cover > raw SM cover
 * 
 * @param coverPath - The cover_path from matched book (e.g., "cache/books/abs_2039.jpg")
 * @param smCoverUrl - The cover_url from SM search result (may be proxy URL)
 * @returns The best available cover URL, or null if none
 */
export function getResultCoverUrl(
  coverPath: string | null | undefined,
  smCoverUrl: string | null | undefined
): string | null {
  // Prefer our DB cached cover
  if (coverPath) {
    const filename = coverPath.split('/').pop();
    if (filename) {
      return `/api/images/books/${filename}`;
    }
  }
  
  // Fall back to SM cover (decode if proxy URL)
  return decodeShelfmarkCoverUrl(smCoverUrl);
}
