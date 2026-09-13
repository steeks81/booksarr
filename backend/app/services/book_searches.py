"""
Book Search Queue Service.

Provides a backend queue for release searches, enabling cross-session/cross-tab
visibility. Similar pattern to the series enrichment worker.

Flow:
1. Frontend calls POST /api/book-search with book info
2. Entry added to queue with status="pending", search_key returned immediately
3. Background worker picks pending entries, calls SM /api/releases (blocking 10-30s)
4. Entry updated with releases or error
5. Frontend polls GET /api/book-searches to see all queue state

Design note: Queue is intentionally in-memory only. Container restart clears all
pending/completed searches. This is acceptable because:
- Searches are cheap to re-queue (just click again)
- Completed searches are transient "clipboard" state, not permanent records
- Avoids DB schema/migration complexity for ephemeral data
"""

import asyncio
import logging
import secrets
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from backend.app.services.shelfmark import get_releases as shelfmark_get_releases

logger = logging.getLogger("booksarr.book_searches")


# --- Data Types ---

@dataclass
class BookInfo:
    """Book metadata from the search result."""
    provider: str
    book_id: str
    title: str
    author: str | None = None
    cover_url: str | None = None
    year: int | None = None
    description: str | None = None
    series_name: str | None = None
    series_position: float | None = None


@dataclass
class ReleaseInfo:
    """A single release/download option from SM."""
    source: str
    source_id: str
    title: str
    author: str | None = None
    format: str | None = None
    size: str | None = None
    language: str | None = None
    indexer: str | None = None
    cover_url: str | None = None
    info_url: str | None = None


@dataclass
class BookSearchEntry:
    """A single entry in the book search queue."""
    search_key: str
    book: BookInfo
    status: str  # pending, fetching, complete, error
    releases: list[ReleaseInfo] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)
    error: str | None = None
    queued_at: datetime = field(default_factory=datetime.utcnow)
    started_at: datetime | None = None
    completed_at: datetime | None = None


# --- Queue Storage ---
# Dict keyed by search_key for O(1) lookups
_searches: dict[str, BookSearchEntry] = {}
_queue: asyncio.Queue[str] = asyncio.Queue()  # Queue of search_keys to process
_worker_task: asyncio.Task | None = None
_worker_lock = asyncio.Lock()


def _generate_search_key() -> str:
    """Generate a unique search key."""
    return secrets.token_urlsafe(8)


def _make_dedup_key(provider: str, book_id: str) -> str:
    """Create a deduplication key from provider and book_id."""
    return f"{provider}:{book_id}"


# --- Public API ---

async def queue_book_search(book: BookInfo) -> tuple[str, bool]:
    """
    Add a book to the release search queue.
    
    Returns (search_key, is_new) immediately. The actual SM call happens in background.
    If the same book (provider:book_id) already exists in queue (any status), returns existing key with is_new=False.
    Use retry endpoint to re-search an existing entry.
    """
    global _worker_task
    
    dedup_key = _make_dedup_key(book.provider, book.book_id)
    
    # Check for existing entry with same provider:book_id (any status)
    # Note: O(n) scan - acceptable for typical queue sizes (tens of entries).
    # If bulk-queue scenarios emerge, consider adding a secondary index by dedup_key.
    for entry in _searches.values():
        if _make_dedup_key(entry.book.provider, entry.book.book_id) == dedup_key:
            logger.info("Book search already in queue: %s (key=%s, status=%s)", 
                       dedup_key, entry.search_key, entry.status)
            return entry.search_key, False
    
    # Create new entry
    search_key = _generate_search_key()
    entry = BookSearchEntry(
        search_key=search_key,
        book=book,
        status="pending",
    )
    _searches[search_key] = entry
    
    # Add to processing queue
    await _queue.put(search_key)
    logger.info("Book search queued: %s '%s' (key=%s)", book.provider, book.title, search_key)
    
    # Ensure worker is running
    async with _worker_lock:
        if _worker_task is None or _worker_task.done():
            _worker_task = asyncio.create_task(_worker_loop())
            logger.info("Book search worker started")
    
    return search_key, True


def get_all_searches() -> list[BookSearchEntry]:
    """Get all book searches, ordered by queued_at (newest first)."""
    return sorted(_searches.values(), key=lambda e: e.queued_at, reverse=True)


def get_searches_by_keys(keys: list[str]) -> list[BookSearchEntry]:
    """Get specific book searches by their keys. O(1) per key."""
    return [_searches[k] for k in keys if k in _searches]


def remove_search(search_key: str) -> bool:
    """Remove a search from the queue. Returns True if found and removed."""
    if search_key in _searches:
        del _searches[search_key]
        logger.info("Book search removed: %s", search_key)
        return True
    return False


def clear_completed_searches() -> int:
    """Remove all completed/errored searches. Returns count removed."""
    to_remove = [k for k, v in _searches.items() if v.status in ("complete", "error")]
    for k in to_remove:
        del _searches[k]
    logger.info("Cleared %d completed book searches", len(to_remove))
    return len(to_remove)


async def retry_book_search(search_key: str) -> bool:
    """
    Re-queue an existing book search to re-fetch releases.
    Only works for complete/error status (not pending/fetching).
    """
    global _worker_task
    
    if search_key not in _searches:
        return False
    
    entry = _searches[search_key]
    if entry.status not in ("complete", "error"):
        return False  # Already in progress
    
    # Reset entry state
    entry.status = "pending"
    entry.releases = []
    entry.sources = []
    entry.error = None
    entry.started_at = None
    entry.completed_at = None
    
    # Re-add to processing queue
    await _queue.put(search_key)
    logger.info("Book search retry queued: %s '%s'", search_key, entry.book.title)
    
    # Ensure worker is running
    async with _worker_lock:
        if _worker_task is None or _worker_task.done():
            _worker_task = asyncio.create_task(_worker_loop())
            logger.info("Book search worker started")
    
    return True


# --- Background Worker ---

async def _worker_loop():
    """Background worker that processes the search queue."""
    logger.info("Book search worker loop started")
    
    while True:
        try:
            # Wait for next search_key (with timeout to allow graceful shutdown)
            try:
                search_key = await asyncio.wait_for(_queue.get(), timeout=30.0)
            except asyncio.TimeoutError:
                # Check if queue is empty and no pending work
                if _queue.empty():
                    pending = [e for e in _searches.values() if e.status == "pending"]
                    if not pending:
                        logger.info("Book search worker idle, exiting")
                        return
                continue
            
            # Get entry
            entry = _searches.get(search_key)
            if not entry:
                logger.warning("Book search not found: %s", search_key)
                continue
            
            if entry.status != "pending":
                logger.debug("Book search already processed: %s (status=%s)", search_key, entry.status)
                continue
            
            # Process the search
            await _process_search(entry)
            
        except Exception as e:
            logger.exception("Book search worker error: %s", e)
            await asyncio.sleep(1)  # Prevent tight loop on persistent errors


async def _process_search(entry: BookSearchEntry):
    """Process a single book search - call SM /api/releases."""
    logger.info("Processing book search: %s '%s'", entry.book.provider, entry.book.title)
    
    entry.status = "fetching"
    entry.started_at = datetime.utcnow()
    
    try:
        # Call SM's releases endpoint (this is blocking, 10-30s+)
        result = await shelfmark_get_releases(
            provider=entry.book.provider,
            book_id=entry.book.book_id,
        )
        
        if result.error:
            entry.status = "error"
            entry.error = result.error
            logger.warning("Book search error: %s - %s", entry.search_key, result.error)
        else:
            entry.status = "complete"
            entry.releases = [
                ReleaseInfo(
                    source=r.source,
                    source_id=r.source_id,
                    title=r.title,
                    author=r.author,
                    format=r.format,
                    size=r.size,
                    language=r.language,
                    indexer=r.indexer,
                    cover_url=r.cover_url,
                    info_url=r.info_url,
                )
                for r in result.releases
            ]
            entry.sources = result.sources
            logger.info("Book search complete: %s - %d releases", entry.search_key, len(entry.releases))
        
    except Exception as e:
        entry.status = "error"
        entry.error = str(e)
        logger.exception("Book search failed: %s - %s", entry.search_key, e)
    
    finally:
        entry.completed_at = datetime.utcnow()


# --- Serialization Helpers ---

def entry_to_dict(entry: BookSearchEntry) -> dict[str, Any]:
    """Convert a BookSearchEntry to a dict for API response."""
    return {
        "search_key": entry.search_key,
        "book": {
            "provider": entry.book.provider,
            "book_id": entry.book.book_id,
            "title": entry.book.title,
            "author": entry.book.author,
            "cover_url": entry.book.cover_url,
            "year": entry.book.year,
            "description": entry.book.description,
            "series_name": entry.book.series_name,
            "series_position": entry.book.series_position,
        },
        "status": entry.status,
        "releases": [
            {
                "source": r.source,
                "source_id": r.source_id,
                "title": r.title,
                "author": r.author,
                "format": r.format,
                "size": r.size,
                "language": r.language,
                "indexer": r.indexer,
                "cover_url": r.cover_url,
                "info_url": r.info_url,
            }
            for r in entry.releases
        ] if entry.releases else None,
        "sources": entry.sources if entry.sources else None,
        "error": entry.error,
        "queued_at": entry.queued_at.isoformat() if entry.queued_at else None,
        "started_at": entry.started_at.isoformat() if entry.started_at else None,
        "completed_at": entry.completed_at.isoformat() if entry.completed_at else None,
    }
