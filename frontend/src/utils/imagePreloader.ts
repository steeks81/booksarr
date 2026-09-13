/**
 * Image preloader with parallel limit
 * Preloads images in batches to avoid overwhelming the browser/network
 */

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
        callbacks.forEach((cb) => cb());
        imageLoadCallbacks.delete(url);
      }
      processImageQueue(); // Process next in queue
    };
    img.src = url;
  }
}

/**
 * Queue an image for preloading
 * @param url - Image URL to preload
 * @param priority - If true, add to front of queue
 * @param onLoad - Optional callback when image loads
 */
export function queueImagePreload(url: string, priority: boolean = false, onLoad?: () => void) {
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

/**
 * Check if an image is already preloaded
 */
export function isImagePreloaded(url: string): boolean {
  return preloadedImages.has(url);
}

/**
 * Preload first N cover images from results (call when results arrive)
 */
export function preloadFirstCovers(
  results: Array<{ cover_url?: string | null }>,
  count: number = 20
) {
  for (let i = 0; i < Math.min(count, results.length); i++) {
    const url = results[i].cover_url;
    if (url) queueImagePreload(url, true); // Priority for first batch
  }
}
