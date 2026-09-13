/**
 * Download progress/status formatting utilities
 * Matches Shelfmark's visual scheme
 */

export type DownloadStatus =
  | 'queued'
  | 'pending'
  | 'resolving'
  | 'locating'
  | 'downloading'
  | 'complete'
  | 'error'
  | 'cancelled';

/**
 * Get text color class for download status
 */
export function getStatusTextColor(status: string): string {
  const s = status as DownloadStatus;
  switch (s) {
    case 'queued':
    case 'pending':
      return 'text-amber-300';
    case 'resolving':
      return 'text-indigo-300';
    case 'locating':
      return 'text-teal-300';
    case 'downloading':
      return 'text-sky-300';
    case 'complete':
      return 'text-green-300';
    case 'error':
      return 'text-red-300';
    case 'cancelled':
      return 'text-gray-400';
    default:
      return 'text-slate-300';
  }
}

/**
 * Get progress bar background color for download status
 */
export function getStatusBarColor(status: string): string {
  const s = status as DownloadStatus;
  switch (s) {
    case 'queued':
    case 'pending':
      return 'bg-amber-600';
    case 'resolving':
      return 'bg-indigo-600';
    case 'locating':
      return 'bg-teal-600';
    case 'downloading':
      return 'bg-sky-600';
    case 'complete':
      return 'bg-green-600';
    case 'error':
      return 'bg-red-600';
    case 'cancelled':
      return 'bg-gray-500';
    default:
      return 'bg-slate-500';
  }
}

/**
 * Get progress bar percentage matching SM's scheme
 * - Queued/Pending: 5%
 * - Resolving: 15%
 * - Locating: 90%
 * - Downloading: 20 + (progress * 0.8)
 * - Complete/Error/Cancelled: 100%
 */
export function getStatusProgress(status: string, progress: number): number {
  const s = status as DownloadStatus;
  switch (s) {
    case 'queued':
    case 'pending':
      return 5;
    case 'resolving':
      return 15;
    case 'locating':
      return 90;
    case 'downloading': {
      // SM formula: 20 + (progress * 0.8), clamped to 0-100
      const clamped = Math.max(0, Math.min(100, progress));
      return Math.min(100, 20 + clamped * 0.8);
    }
    case 'complete':
    case 'error':
    case 'cancelled':
      return 100;
    default:
      return 0;
  }
}

/**
 * Format download progress like SM: "9.4MB / 37.7 MB"
 */
export function formatDownloadProgress(progress: number, sizeRaw?: string | null): string {
  if (sizeRaw) {
    const sizeValue = parseFloat(sizeRaw.replace(/[^\d.]/g, ''));
    const sizeUnit = sizeRaw.replace(/[\d.\s]/g, '');
    if (sizeValue > 0) {
      const downloaded = (progress / 100) * sizeValue;
      return `${downloaded.toFixed(1)}${sizeUnit} / ${sizeRaw}`;
    }
  }
  return `${Math.round(progress)}%`;
}

/**
 * Title case status for display (SM returns lowercase)
 */
export function formatStatus(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}
