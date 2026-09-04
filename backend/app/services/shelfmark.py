"""
Shelfmark integration service.

Provides session-managed access to a Shelfmark instance for searching
books from Anna's Archive without leaving Booksarr.

Flow:
1. User clicks "Search Shelfmark" on a book in Booksarr
2. Booksarr backend proxies search to SM's /api/metadata/search (requires auth)
3. Results displayed in Booksarr modal
4. User clicks a result -> opens SM directly for download (Cloudflare wait happens there)
"""

import asyncio
import logging
import re
import time
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, AsyncGenerator

import httpx

from backend.app.database import async_session
from backend.app.models import Setting, Book, Series, BookSeries
from backend.app.schemas.book import SeriesPositionInfo
from sqlalchemy import select

logger = logging.getLogger("booksarr.shelfmark")

# Internal Docker hostname for faster API calls (internal port is 8084)
_INTERNAL_SM_URL = "http://shelfmark:8084"

# Cached working URL (None = not tested yet)
_cached_sm_url: str | None = None

# Session cache - stores authenticated session cookies
_session_cache: dict[str, Any] = {}
_session_lock = asyncio.Lock()

# Session expires after 1 hour of inactivity
SESSION_EXPIRY_MINUTES = 60


# --- Series Info Cache ---
# In-memory cache for series info, keyed by "provider:book_id"
# Survives until container restart
_series_cache: dict[str, SeriesPositionInfo] = {}
_series_cache_lock = asyncio.Lock()


# --- Series Enrichment: single shared worker + append/prepend queue ---
#
# Design (see design.md / testing.md):
# - ONE background worker drains a shared queue. Never run two loops concurrently
#   (double request rate => guaranteed Hardcover rate limiting).
# - New searches PREPEND their uncached books (dedup) so the search the user is
#   currently looking at is prioritized. Old work stays queued behind and resumes.
# - Progress is per-search on the frontend: each search polls with ITS book_ids and
#   counts how many are now cached. The global status only carries worker-running +
#   rate-limit state (rate limiting is a global condition, shared across tabs/users).
@dataclass
class SeriesEnrichStatus:
    """Global status of the shared enrichment worker."""
    status: str  # idle, running
    queue_size: int = 0
    processed: int = 0  # total books processed since worker (re)started
    rate_limited: bool = False
    message: str | None = None


_enrich_status = SeriesEnrichStatus(status="idle")
_enrich_queue: deque[dict[str, str]] = deque()
_enrich_queued_keys: set[str] = set()  # "provider:book_id" currently in queue (dedup)
_enrich_worker_task: asyncio.Task | None = None
_enrich_lock = asyncio.Lock()

# --- DEBUG/TESTING: Enrichment Allowlist ---
# When set, only these book IDs will be enriched (hit SM). Others skip silently.
# Set to None to allow all (normal operation).
# Format: set of "provider:book_id" strings, e.g. {"hardcover:2846924"}
# Safe to remove in production. Search "DEBUG/TESTING" to find all related code.
_enrich_allowlist: set[str] | None = None


def set_enrich_allowlist(allowlist: set[str] | None) -> None:
    """DEBUG: Set the enrichment allowlist. None = allow all (normal operation)."""
    global _enrich_allowlist
    _enrich_allowlist = allowlist
    if allowlist:
        logger.info("Enrichment allowlist SET: %d entries", len(allowlist))
    else:
        logger.info("Enrichment allowlist CLEARED (all books allowed)")

# --- END DEBUG/TESTING: Enrichment Allowlist ---


def get_enrich_status() -> SeriesEnrichStatus:
    """Get the current global worker status."""
    _enrich_status.queue_size = len(_enrich_queue)
    # Also check if worker task is pending but not yet running (asyncio scheduled)
    if _enrich_worker_task is not None and not _enrich_worker_task.done():
        _enrich_status.status = "running"
    return _enrich_status


# --- Global Hardcover Rate Limiter ---
#
# HC limits: 60 req/min sustained, burst of 10, 5000/day.
# SM masks HC 429s as "Book not found" - we can't read the actual 429.
# This limiter tracks ALL BA→SM calls that hit HC (search pagination, enrichment, etc.)
# and enforces the limit proactively rather than reactively detecting errors.
#
# See design.md P1-F11-S4 for full design rationale.

class HCRateLimiter:
    """Global rate limiter for Hardcover API calls via Shelfmark."""
    MAX_PER_MINUTE = 55  # Leave headroom below HC's 60/min limit
    
    def __init__(self):
        self._timestamps: deque[float] = deque()
        self._lock = asyncio.Lock()
    
    async def acquire(self, block: bool = True) -> tuple[bool, float]:
        """Check rate limit budget.
        
        Args:
            block: If True, wait until budget available. If False, return immediately
                   (but still waits if delay is < 2s to avoid "try again in 0s" UX).
        
        Returns:
            (allowed, wait_time) - allowed=True if call can proceed, 
            wait_time is seconds until budget available (0 if allowed)
        """
        async with self._lock:
            now = time.monotonic()
            # Prune timestamps older than 60s
            while self._timestamps and now - self._timestamps[0] > 60:
                self._timestamps.popleft()
            
            if len(self._timestamps) >= self.MAX_PER_MINUTE:
                wait_time = 60 - (now - self._timestamps[0])
                if wait_time <= 0:
                    # Edge case: oldest just expired, remove it
                    self._timestamps.popleft()
                elif block or wait_time < 2.0:
                    # Always wait if block=True, or if wait is trivially short
                    logger.info("HC rate limiter: at capacity (%d/%d), waiting %.1fs",
                               len(self._timestamps), self.MAX_PER_MINUTE, wait_time)
                    await asyncio.sleep(wait_time)
                    self._timestamps.popleft()  # Remove expired oldest
                else:
                    logger.info("HC rate limiter: at capacity (%d/%d), rejecting (wait would be %.1fs)",
                               len(self._timestamps), self.MAX_PER_MINUTE, wait_time)
                    return (False, wait_time)
            
            self._timestamps.append(time.monotonic())
            return (True, 0)
    
    def get_stats(self) -> dict[str, Any]:
        """Return current rate limiter stats for debugging."""
        now = time.monotonic()
        # Count only non-expired timestamps
        active = sum(1 for ts in self._timestamps if now - ts <= 60)
        return {
            "calls_in_window": active,
            "max_per_minute": self.MAX_PER_MINUTE,
            "headroom": self.MAX_PER_MINUTE - active,
        }
    
    def clear(self) -> None:
        """Clear all timestamps (reset rate limiter window)."""
        self._timestamps.clear()


# Module-level singleton
_hc_rate_limiter = HCRateLimiter()


def get_hc_rate_limiter() -> HCRateLimiter:
    """Get the global HC rate limiter instance."""
    return _hc_rate_limiter


def get_cached_series_for(
    books: list[dict[str, str]],
) -> dict[str, dict[str, Any]]:
    """Return cached series info for the given books, keyed by book_id.

    Only includes books that are currently in the cache. Frontend uses this to
    (a) count how many of ITS books are done (X/Y) and (b) fill the results table
    progressively as the shared worker caches each book.
    """
    out: dict[str, dict[str, Any]] = {}
    for book in books:
        provider = book.get("provider")
        book_id = book.get("book_id")
        if not provider or not book_id:
            continue
        cached = get_series_from_cache(provider, book_id)
        if cached is not None:
            out[book_id] = {
                "series_id": cached.provider_id,  # Frontend expects series_id for SM search
                "series_name": cached.series_name,
                "series_position": cached.series_position,
                "series_count": cached.series_count,
                "isbn": cached.isbn,
            }
    return out


def get_series_from_cache(provider: str, book_id: str) -> SeriesPositionInfo | None:
    """Get series info from cache if available."""
    key = f"{provider}:{book_id}"
    return _series_cache.get(key)


def set_series_in_cache(
    provider: str,
    book_id: str,
    provider_id: str | None,
    series_name: str | None,
    series_position: int | float | None,
    series_count: int | None,
    isbn: str | None = None,
) -> None:
    """Store series info in cache."""
    key = f"{provider}:{book_id}"
    _series_cache[key] = SeriesPositionInfo(
        provider_id=provider_id,
        series_name=series_name,
        series_position=series_position,
        series_count=series_count,
        isbn=isbn,
        fetched_at=datetime.now(),
    )


def get_series_cache_stats() -> dict[str, Any]:
    """Get cache statistics."""
    return {
        "size": len(_series_cache),
        "entries": list(_series_cache.keys()),  # All entries for debugging
    }


# --- DEBUG/TESTING: Cache dump/restore and enrichment allowlist ---
# These functions support testing without hitting external APIs.
# Safe to remove in production if not needed. Search "DEBUG/TESTING" to find all related code.

def dump_series_cache() -> list[dict[str, Any]]:
    """DEBUG: Dump full cache contents for backup/restore."""
    result = []
    for key, info in _series_cache.items():
        provider, book_id = key.split(":", 1)
        result.append({
            "provider": provider,
            "book_id": book_id,
            "provider_id": info.provider_id,
            "series_name": info.series_name,
            "series_position": info.series_position,
            "series_count": info.series_count,
            "isbn": info.isbn,
        })
    return result


def restore_series_cache(entries: list[dict[str, Any]]) -> int:
    """DEBUG: Restore cache from dump. Returns count of entries restored."""
    count = 0
    for entry in entries:
        set_series_in_cache(
            provider=entry.get("provider", "hardcover"),
            book_id=str(entry.get("book_id")),
            provider_id=entry.get("provider_id"),
            series_name=entry.get("series_name"),
            series_position=entry.get("series_position"),
            series_count=entry.get("series_count"),
            isbn=entry.get("isbn"),
        )
        count += 1
    logger.info("Series cache restored: %d entries", count)
    return count

# --- END DEBUG/TESTING: Cache dump/restore ---

def clear_series_cache() -> None:
    """Clear the series cache."""
    _series_cache.clear()
    logger.info("Series cache cleared")


async def persist_series_to_db(
    hardcover_id: int,
    series_name: str,
    series_position: float | None,
) -> bool:
    """
    Persist series info to DB if the book exists by hardcover_id.
    
    Creates Series record if needed, then links via BookSeries.
    Returns True if persisted, False if book not found in DB.
    """
    async with async_session() as db:
        # Find book by hardcover_id
        result = await db.execute(
            select(Book).where(Book.hardcover_id == hardcover_id)
        )
        book = result.scalar_one_or_none()
        
        if not book:
            return False
        
        # Get or create series (by name since we don't have HC series ID from SM)
        result = await db.execute(
            select(Series).where(Series.name == series_name)
        )
        series = result.scalar_one_or_none()
        
        if not series:
            series = Series(name=series_name)
            db.add(series)
            await db.flush()
        
        # Check if book_series link already exists
        result = await db.execute(
            select(BookSeries).where(
                BookSeries.book_id == book.id,
                BookSeries.series_id == series.id,
            )
        )
        existing = result.scalar_one_or_none()
        
        if not existing:
            db.add(BookSeries(
                book_id=book.id,
                series_id=series.id,
                position=series_position,
            ))
            await db.commit()
            logger.debug("Persisted series '%s' pos=%s for book %d (hc:%d)", 
                        series_name, series_position, book.id, hardcover_id)
            return True
        
        # Link exists - update position if different
        if existing.position != series_position:
            existing.position = series_position
            await db.commit()
            logger.debug("Updated series position to %s for book %d", series_position, book.id)
        
        return True


@dataclass
class ShelfmarkSession:
    """Cached Shelfmark session with cookies."""
    cookies: dict[str, str]
    created_at: datetime
    last_used: datetime


def clear_session_cache() -> None:
    """Clear the cached Shelfmark session. Called when credentials change."""
    global _session_cache
    _session_cache = {}
    logger.info("Shelfmark session cache cleared")


def clear_url_cache() -> None:
    """Clear the cached Shelfmark URL. Called when URL setting changes."""
    global _cached_sm_url
    _cached_sm_url = None
    logger.info("Shelfmark URL cache cleared")


async def get_internal_url() -> str:
    """Get the internal URL for backend API calls.
    
    Tries internal Docker URL first, falls back to configured URL.
    Result is cached for app lifetime (only tests once).
    """
    global _cached_sm_url
    
    # Return cached result if we've already tested
    if _cached_sm_url is not None:
        return _cached_sm_url
    
    settings = await _get_settings()
    configured_url = settings["url"]
    
    if not configured_url:
        raise ShelfmarkError("Shelfmark URL not configured")
    
    # Try internal Docker URL first
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            resp = await client.get(f"{_INTERNAL_SM_URL}/")
            if resp.status_code == 200:
                logger.info("Using internal Shelfmark URL: %s", _INTERNAL_SM_URL)
                _cached_sm_url = _INTERNAL_SM_URL
                return _cached_sm_url
    except Exception:
        pass
    
    # Internal doesn't work, use configured
    logger.info("Using configured Shelfmark URL: %s", configured_url)
    _cached_sm_url = configured_url
    return _cached_sm_url


async def get_external_url() -> str:
    """Get the external URL for browser-accessible links (covers, etc.).
    
    Returns the configured URL from settings.
    """
    settings = await _get_settings()
    configured_url = settings["url"]
    
    if not configured_url:
        raise ShelfmarkError("Shelfmark URL not configured")
    
    return configured_url


async def _get_settings() -> dict[str, str]:
    """Load Shelfmark settings from database."""
    import os
    
    async with async_session() as db:
        result = await db.execute(select(Setting))
        settings = {s.key: s.value for s in result.scalars().all()}
    
    return {
        "url": settings.get("shelfmark_url") or os.environ.get("SHELFMARK_URL", ""),
        "username": settings.get("shelfmark_username") or os.environ.get("SHELFMARK_USERNAME", ""),
        "password": settings.get("shelfmark_password") or os.environ.get("SHELFMARK_PASSWORD", ""),
    }


async def _login(client: httpx.AsyncClient, base_url: str, username: str, password: str) -> dict[str, str]:
    """
    Authenticate with Shelfmark via POST /api/auth/login.
    
    Returns session cookies on success.
    """
    login_url = f"{base_url.rstrip('/')}/api/auth/login"
    
    login_data = {
        "username": username,
        "password": password,
    }
    
    try:
        resp = await client.post(
            login_url,
            json=login_data,
            follow_redirects=False,
        )
    except httpx.HTTPError as e:
        logger.error("Shelfmark login request failed: %s", e)
        raise ShelfmarkError(f"Cannot reach Shelfmark at {base_url}") from e
    
    if resp.status_code == 401:
        logger.warning("Shelfmark login failed: invalid credentials")
        raise ShelfmarkError("Login failed - check username and password")
    
    if resp.status_code not in (200, 201):
        logger.warning("Shelfmark login returned unexpected status: %s", resp.status_code)
        raise ShelfmarkError(f"Login failed with status {resp.status_code}")
    
    # Extract cookies from the client (accumulated from response)
    cookies = dict(client.cookies)
    
    if not cookies:
        # Try response cookies directly
        for cookie in resp.cookies.jar:
            cookies[cookie.name] = cookie.value
    
    if not cookies:
        logger.warning("No session cookies received after Shelfmark login")
        raise ShelfmarkError("Login failed - no session cookie received")
    
    logger.info("Shelfmark login successful, session established")
    return cookies


async def _get_authenticated_session() -> dict[str, str]:
    """
    Get or create an authenticated Shelfmark session.
    
    Returns session cookies for authentication.
    Uses internal URL for login (faster).
    """
    global _session_cache
    
    settings = await _get_settings()
    username = settings["username"]
    password = settings["password"]
    
    if not username or not password:
        raise ShelfmarkError("Shelfmark credentials not configured")
    
    # Get internal URL for login
    api_url = await get_internal_url()
    
    async with _session_lock:
        cache_key = f"{api_url}:{username}"
        session = _session_cache.get(cache_key)
        
        now = datetime.utcnow()
        if session:
            if now - session.last_used < timedelta(minutes=SESSION_EXPIRY_MINUTES):
                session.last_used = now
                return session.cookies
            else:
                logger.info("Shelfmark session expired, re-authenticating")
                del _session_cache[cache_key]
        
        # Create new session
        async with httpx.AsyncClient(timeout=30.0) as client:
            cookies = await _login(client, api_url, username, password)
        
        _session_cache[cache_key] = ShelfmarkSession(
            cookies=cookies,
            created_at=now,
            last_used=now,
        )
        
        return cookies


@dataclass
class ShelfmarkSearchResult:
    """A single search result from Shelfmark."""
    id: str
    title: str
    author: str | None
    format: str | None
    size: str | None
    source: str | None  # Display name (e.g., "Google Books", "Hardcover")
    provider: str | None  # Provider code (e.g., "googlebooks", "hardcover")
    download_url: str | None
    cover_url: str | None
    # Additional metadata fields
    year: int | None = None
    description: str | None = None
    source_url: str | None = None
    isbn: str | None = None
    # Series info
    series_id: str | None = None  # Provider-specific series ID (e.g., HC series id)
    series_name: str | None = None
    series_position: float | None = None
    series_count: int | None = None
    # Display fields (rating, readers, etc.)
    display_fields: list[dict] | None = None


@dataclass
class ShelfmarkSearchResponse:
    """Response from a Shelfmark search."""
    query: str
    results: list[ShelfmarkSearchResult]
    total_results: int
    shelfmark_url: str | None = None
    error: str | None = None


class ShelfmarkError(Exception):
    """Error communicating with Shelfmark."""
    pass


async def search(query: str, media_type: str = "ebook", series: str | None = None, author: str | None = None, title: str | None = None, isbn: str | None = None, author_hardcover_id: int | None = None, series_hardcover_id: int | None = None) -> ShelfmarkSearchResponse:
    """
    Search Shelfmark for books via GET /api/metadata/search.
    
    Args:
        query: Search query (title, author, or both)
        media_type: "ebook" or "audiobook"
        series: Series name to search for (uses SM's series field)
        author: Author name to search for (uses SM's author field)
        title: Title to search for (uses SM's title field)
        isbn: ISBN to search for (uses SM's search_type=isbn for exact lookup)
        author_hardcover_id: Hardcover author id (from our DB). When provided,
            search by "id:<n>" so SM uses its by-id author catalog (respects
            limit=100) instead of degrading to a capped keyword search.
        series_hardcover_id: Hardcover series id (from our DB). Same benefit for
            series search (SM's canonical by-id series order).
    
    Returns:
        ShelfmarkSearchResponse with results
    """
    # Normalize inputs
    # Normalize inputs
    # Helper: remove Unicode whitespace, zero-width chars, and formatting characters
    def normalize_text(text: str | None) -> str:
        """Remove Unicode whitespace, zero-width chars, and formatting chars that shouldn't be in text."""
        if not text:
            return ""
        # Remove zero-width chars, soft hyphens, and other invisible Unicode formatting
        # \s includes all Unicode whitespace (spaces, tabs, newlines, zero-width spaces U+200B, etc.)
        # \u200c=ZWJ, \u200d=ZWJ, \u00ad=soft hyphen, \ufeff=BOM
        text = re.sub(r'[\s\u200b\u200c\u200d\u00ad\ufeff]+', ' ', text)
        return text.strip()
    
    def normalize_isbn(text: str | None) -> str:
        """For ISBN: keep only alphanumeric characters (digits and letters).
        
        Removes formatting, whitespace, and special characters.
        Let Shelfmark validate the format.
        """
        if not text:
            return ""
        # Keep only alphanumeric characters (0-9, a-zA-Z)
        cleaned = re.sub(r'[^\w]', '', text, flags=re.UNICODE)
        return cleaned.strip()
    
    query = normalize_text(query)
    series = normalize_text(series) or None
    author = normalize_text(author) or None
    title = normalize_text(title) or None
    isbn = normalize_isbn(isbn) or None  # ISBN: digits + optional X check digit
    
    if not query and not series and not author and not title and not isbn:
        return ShelfmarkSearchResponse(
            query=query,
            results=[],
            total_results=0,
            error="Empty search query",
        )
    
    try:
        cookies = await _get_authenticated_session()
        api_url = await get_internal_url()
        browser_url = await get_external_url()
    except ShelfmarkError as e:
        return ShelfmarkSearchResponse(
            query=query,
            results=[],
            total_results=0,
            error=str(e),
        )
    
    # Shelfmark metadata search endpoint
    search_url = f"{api_url.rstrip('/')}/api/metadata/search"
    
    params: dict[str, str] = {}
    # Store author filter for post-search filtering (when series + author both provided)
    author_filter: str | None = None
    
    # SM's /api/metadata/search expects custom fields as query params:
    # - series=SeriesName (for Hardcover - has series search field)
    # - author=AuthorName  
    # - title=Title
    # - query=GeneralSearch (default text search, works with all providers)
    # 
    # Not all providers support all fields (e.g., Google Books has no series field).
    # We include both the specific field AND query as fallback for providers that
    # don't support that field.
    # 
    # When both series AND author are provided, search by series then filter by author
    #
    # ID-based search (preferred when we have a Hardcover id from our DB): send SM
    # the field as "id:<n>". SM then uses its by-id catalog path
    # (_fetch_series_books_by_id / _fetch_author_books_by_id), which respects
    # limit=100 and returns the real catalog - avoiding HC's 25/page keyword cap
    # (that keyword fallback + our max_pages=10 is what produced the "250" ceiling).
    # We DROP the `query` fallback in the id case so SM can't degrade to keyword.
    # When no id is available, behaviour is unchanged (name + query fallback).
    if series and author:
        if series_hardcover_id is not None:
            params["series"] = f"id:{series_hardcover_id}"
            logger.info("Search type: SERIES search by id:%s (will filter to author '%s')", series_hardcover_id, author)
        else:
            params["series"] = series
            params["query"] = series  # Fallback for providers without series field
            logger.info("Search type: SERIES search for '%s' (will filter to author '%s')", series, author)
        author_filter = author.lower()
    elif series:
        if series_hardcover_id is not None:
            params["series"] = f"id:{series_hardcover_id}"
            logger.info("Search type: SERIES search by id:%s ('%s')", series_hardcover_id, series)
        else:
            params["series"] = series
            params["query"] = series  # Fallback for providers without series field
            logger.info("Search type: SERIES search for '%s'", series)
    elif author:
        if author_hardcover_id is not None:
            params["author"] = f"id:{author_hardcover_id}"
            logger.info("Search type: AUTHOR search by id:%s ('%s')", author_hardcover_id, author)
        else:
            params["author"] = author
            params["query"] = author  # Fallback for providers without author field
    elif title:
        params["title"] = title
        params["query"] = title  # Fallback for providers without title field
        logger.info("Search type: TITLE search for '%s'", title)
    elif isbn:
        # ISBN search uses SM's dedicated search_type=isbn for exact lookup
        params["query"] = isbn
        params["search_type"] = "isbn"
        logger.info("Search type: ISBN search for '%s'", isbn)
    elif query:
        params["query"] = query
        logger.info("Search type: GENERAL search for '%s'", query)
    # Add media type if audiobook (default is likely ebook)
    if media_type == "audiobook":
        params["type"] = "audiobook"
    # Request maximum results per page
    params["limit"] = "100"
    
    # Fetch all pages from SM
    all_raw_results: list[dict] = []
    page = 1
    max_pages = 50  # Safety limit - effectively unlimited for realistic catalogs
    prev_total_found: int | None = None  # Track for rate limit detection
    possible_rate_limit = False
    
    try:
        async with httpx.AsyncClient(timeout=60.0, cookies=cookies) as client:
            while page <= max_pages:
                # Rate limit check: first page rejects if at limit, subsequent pages wait
                if page == 1:
                    allowed, wait_time = await _hc_rate_limiter.acquire(block=False)
                    if not allowed:
                        return ShelfmarkSearchResponse(
                            query=query,
                            results=[],
                            total_results=0,
                            shelfmark_url=browser_url,
                            error=f"Rate limited, try again in {int(wait_time)}s",
                        )
                else:
                    # Already committed to this search, wait if needed
                    await _hc_rate_limiter.acquire(block=True)
                
                params["page"] = str(page)
                resp = await client.get(search_url, params=params)
                
                if resp.status_code == 401 and page == 1:
                    # Session expired, clear cache and retry once
                    logger.info("Shelfmark session expired during search, re-authenticating")
                    clear_session_cache()
                    cookies = await _get_authenticated_session()
                    async with httpx.AsyncClient(timeout=60.0, cookies=cookies) as retry_client:
                        resp = await retry_client.get(search_url, params=params)
                
                resp.raise_for_status()
                data = resp.json()
                
                # Extract results from this page
                page_results = data if isinstance(data, list) else data.get("results", data.get("items", data.get("books", [])))
                if page_results:
                    all_raw_results.extend(page_results)
                
                # Check if more pages exist
                has_more = data.get("has_more", False) if isinstance(data, dict) else False
                total_found = data.get("total_found") if isinstance(data, dict) else None
                logger.info("SM search page %d: got %d results, has_more=%s, total_found=%s (running total=%d)",
                            page, len(page_results or []), has_more, total_found, len(all_raw_results))
                
                # Detect possible rate limit scenarios:
                # 1. total_found drops from >0 to 0 between pages (HC 429'd mid-search)
                # 2. First page returns 0 for a by-id search (HC 429'd, no results returned)
                if prev_total_found and prev_total_found > 0 and total_found == 0:
                    logger.warning("SM search total_found dropped from %d to 0 on page %d - possible rate limit",
                                   prev_total_found, page)
                    possible_rate_limit = True
                elif page == 1 and total_found == 0 and (author_hardcover_id or series_hardcover_id):
                    # By-id searches should always return results if the ID exists
                    # 0 results on first page likely means HC rate limit
                    logger.warning("SM search by-id returned 0 results on first page - likely rate limited")
                    possible_rate_limit = True
                prev_total_found = total_found
                
                if not has_more or not page_results:
                    break
                    
                page += 1
            else:
                # Loop exhausted max_pages without has_more going false
                logger.warning("SM search hit max_pages=%d cap (running total=%d) - results may be truncated",
                               max_pages, len(all_raw_results))
                
    except httpx.HTTPStatusError as e:
        logger.error("Shelfmark search HTTP error: %s %s", e.response.status_code, e.response.text[:500] if e.response.text else "")
        return ShelfmarkSearchResponse(
            query=query,
            results=[],
            total_results=0,
            shelfmark_url=browser_url,
            error=f"Search failed: HTTP {e.response.status_code}",
        )
    except httpx.HTTPError as e:
        logger.error("Shelfmark search error: %s", e)
        return ShelfmarkSearchResponse(
            query=query,
            results=[],
            total_results=0,
            shelfmark_url=browser_url,
            error=f"Search failed: {e}",
        )
    except ShelfmarkError as e:
        return ShelfmarkSearchResponse(
            query=query,
            results=[],
            total_results=0,
            error=str(e),
        )
    except Exception as e:
        logger.exception("Unexpected error during Shelfmark search")
        return ShelfmarkSearchResponse(
            query=query,
            results=[],
            total_results=0,
            shelfmark_url=browser_url,
            error=f"Search failed: {e}",
        )
    
    # Parse response - adapt to actual Shelfmark API response structure
    results = []
    raw_results = all_raw_results
    
    # Log first result structure to help identify field names
    if raw_results and len(raw_results) > 0:
        first = raw_results[0]
        logger.info("Shelfmark result sample keys: %s", list(first.keys()) if isinstance(first, dict) else "not a dict")
        # Log author fields specifically to debug narrator issue
        if isinstance(first, dict):
            logger.info("Shelfmark author fields: search_author=%r authors=%r", first.get("search_author"), first.get("authors"))
            # Log ISBN fields to debug missing ISBN
            logger.info("Shelfmark ISBN fields: isbn_13=%r isbn_10=%r isbn=%r", first.get("isbn_13"), first.get("isbn_10"), first.get("isbn"))
    
    for item in raw_results:
        # Handle various possible field names from Shelfmark
        result_id = str(item.get("id", item.get("md5", item.get("edition_id", item.get("provider_id", "")))))
        
        # Author - prefer authors list (full names) over search_author (may be truncated)
        # search_author is often just last name (e.g., "Jucha" instead of "S. H. Jucha")
        # authors list contains full names but may include narrator for audiobooks
        author = None
        authors_list = item.get("authors", [])
        if isinstance(authors_list, list) and authors_list:
            # Use first author only to avoid narrator pollution in audiobooks
            author = str(authors_list[0]) if authors_list else None
        elif isinstance(authors_list, str):
            author = authors_list
        
        # Fallback to search_author if authors empty
        if not author:
            author = item.get("search_author") or item.get("author")
        
        # Size could be bytes or formatted string
        size = item.get("size", item.get("filesize", item.get("file_size", "")))
        if isinstance(size, int):
            if size > 1024 * 1024:
                size = f"{size / (1024 * 1024):.1f} MB"
            elif size > 1024:
                size = f"{size / 1024:.1f} KB"
            else:
                size = f"{size} B"
        
        # Cover URL - may be relative, needs browser URL prefix for client access
        cover = item.get("cover_url", item.get("cover", item.get("image_url", item.get("thumbnail", item.get("coverUrl", item.get("imageUrl", None))))))
        if cover and cover.startswith("/"):
            cover = f"{browser_url.rstrip('/')}{cover}"
        
        # Year
        year = item.get("publish_year", item.get("year", None))
        
        # Description
        description = item.get("description", None)
        
        # Source URL (link to provider page)
        source_url = item.get("source_url", None)
        
        # ISBN
        isbn = item.get("isbn_13") or item.get("isbn_10") or item.get("isbn", None)
        
        # Series info - SM now includes this in search results
        series_id = item.get("series_id") or None  # Provider-specific series ID
        series_name = item.get("series_name") or None  # Convert empty string to None
        series_position = item.get("series_position", None)
        series_count = item.get("series_count", None)
        
        # Display fields (rating, readers, etc.)
        display_fields = item.get("display_fields", None)
        
        # Provider code (e.g., "googlebooks", "hardcover")
        provider = item.get("provider", None)
        
        results.append(ShelfmarkSearchResult(
            id=result_id,
            title=item.get("title", "Unknown"),
            author=author if author else None,
            format=item.get("format", item.get("extension", item.get("file_type", None))),
            size=str(size) if size else None,
            source=item.get("source", item.get("provider_display_name", None)),
            provider=provider,
            download_url=item.get("download_url", item.get("url", None)),
            cover_url=cover,
            year=year,
            description=description,
            source_url=source_url,
            isbn=isbn,
            series_id=series_id,
            series_name=series_name,
            series_position=series_position,
            series_count=series_count,
            display_fields=display_fields,
        ))
    
    total = len(results)
    if isinstance(data, dict):
        total = data.get("total", data.get("total_results", data.get("count", len(results))))
    
    # Apply author filter if searching series + author
    if author_filter and results:
        filtered_results = []
        for r in results:
            # Check if any author in the result matches the filter
            result_author = (r.author or "").lower()
            if author_filter in result_author or result_author in author_filter:
                filtered_results.append(r)
        
        logger.info("Shelfmark search: filtered %d results to %d for author '%s'", 
                   len(results), len(filtered_results), author_filter)
        results = filtered_results
        total = len(results)
    
    logger.info("Shelfmark search completed: query=%r results=%d", query, len(results))
    
    # Determine error message based on rate limit detection
    error_msg = None
    if possible_rate_limit:
        if len(results) == 0:
            error_msg = "No results - Hardcover may be rate limited. Try again in a few minutes."
        else:
            error_msg = "Results may be incomplete (possible rate limit)"
    
    return ShelfmarkSearchResponse(
        query=query,
        results=results,
        total_results=total,
        shelfmark_url=browser_url,
        error=error_msg,
    )


async def enrich_series_stream(
    books: list[dict[str, str]],
) -> AsyncGenerator[dict[str, Any], None]:
    """
    Stream series info for a list of books.
    
    Yields progress updates and series info as JSON events:
    - {"type": "progress", "current": 5, "total": 20}
    - {"type": "series", "book_id": "123", "series_name": "...", "series_position": 1, "series_count": 10}
    - {"type": "done"}
    - {"type": "ping"} - keepalive to prevent connection timeout
    
    Uses backend in-memory cache:
    - Cache hit → return instantly (no SM call)
    - Cache miss → call SM, store in cache
    
    Uses adaptive rate limiting for SM calls:
    - Burst mode by default (no delays between requests)
    - On error, wait and retry, then enter delayed mode for cooldown period
    - After cooldown, try burst mode again
    
    Args:
        books: List of dicts with "provider" and "book_id" keys
    """
    import time
    
    from collections import deque

    total = len(books)
    PING_INTERVAL = 15.0  # Send keepalive ping every 15 seconds
    
    # Rate limit handling with exponential backoff.
    # NOTE: Shelfmark's get_book path swallows Hardcover 429s and returns them as a
    # plain 404 "Book not found" (SM calls HC with raise_on_error=False, so the
    # rate-limit status/headers are lost). We therefore cannot read "429"/Retry-After
    # from the error string. Instead we detect rate limiting by PATTERN: a cluster of
    # "Book not found" errors from the hardcover provider within a short window is
    # (almost) always throttling, not genuinely missing books. See testing.md Test 5.
    INITIAL_BACKOFF = 2.0  # Starting backoff for rate limits (also the lone-error retry wait)
    MAX_BACKOFF = 60.0  # Max backoff (should allow burst bucket to refill)
    MAX_RETRIES_AT_MAX = 3  # Give up after this many attempts at max backoff
    RL_WINDOW_SECONDS = 60.0  # Rolling window for rate-limit pattern detection
    RL_THRESHOLD = 3  # >= this many HC "Book not found" errors in the window => throttled
                      # (3 tolerates a genuine pair of missing books within 60s; real
                      #  throttling produces ~5 errors/min so it still trips reliably)
    
    cache_hits = 0
    cache_misses = 0
    last_ping = time.monotonic()
    
    # Error tracking
    error_count = 0
    skipped_count = 0  # Books skipped due to errors (miss / transient / throttle-skip)
    
    # Rate limit backoff state
    current_backoff = INITIAL_BACKOFF
    retries_at_max_backoff = 0
    rl_events: deque[float] = deque()  # timestamps of HC "Book not found" errors
    
    def note_and_check_rl(provider: str | None, error_str: str | None) -> bool:
        """Record an HC 'Book not found' (SM's masked 429) into the rolling window
        and report whether the rate-limit pattern has tripped.

        Only hardcover 'Book not found' counts toward the pattern - other providers'
        404s and other error strings are treated as genuine (skipped, not throttled).
        """
        now = time.monotonic()
        while rl_events and now - rl_events[0] > RL_WINDOW_SECONDS:
            rl_events.popleft()
        if provider == "hardcover" and error_str == "Book not found":
            rl_events.append(now)
        return len(rl_events) >= RL_THRESHOLD
    
    # Log cache state at start
    start_time = time.monotonic()
    logger.info("Series enrichment START: %d books to process, cache size=%d", total, len(_series_cache))
    
    for i, book in enumerate(books):
        provider = book.get("provider")
        book_id = book.get("book_id")
        
        if not provider or not book_id:
            continue
        
        # Send keepalive ping if needed (prevents browser/proxy timeout)
        now = time.monotonic()
        if now - last_ping > PING_INTERVAL:
            yield {"type": "ping"}
            last_ping = now
        
        # Yield progress
        yield {"type": "progress", "current": i + 1, "total": total}
        
        # Check cache first
        cached = get_series_from_cache(provider, book_id)
        if cached is not None:
            cache_hits += 1
            logger.debug("Cache hit for %s:%s -> series=%s pos=%s", provider, book_id, cached.series_name, cached.series_position)
            if cached.series_position is not None:
                yield {
                    "type": "series",
                    "book_id": book_id,
                    "series_name": cached.series_name,
                    "series_position": cached.series_position,
                    "series_count": cached.series_count,
                }
            continue
        
        cache_misses += 1
        logger.info("Cache miss for %s:%s (cache has %d entries)", provider, book_id, len(_series_cache))
        
        # Fetch book details from SM
        try:
            detail = await get_book(provider, book_id)
            
            # --- Error handling (Option C: unified backoff ladder, no separate fast retry) ---
            # A lone error gets ONE retry after INITIAL_BACKOFF (2s) - this doubles as
            # both the "shrug off a blip" retry and the first rung of the backoff ladder,
            # so we never double-wait. If the pattern detector trips (HC throttling), we
            # escalate the backoff (2 -> 4 -> ... -> 60s) instead of skipping, and stop
            # after MAX_RETRIES_AT_MAX failures at max backoff (covers the daily-cap hard fail).
            if detail.error:
                first_error = detail.error
                error_count += 1  # count each book that errors once (retries don't re-count)
                rate_limited = note_and_check_rl(provider, detail.error)
                book_skipped = False
                
                while detail.error:
                    if rate_limited:
                        logger.warning("Rate limit pattern detected for %s/%s: %s - backing off %.1fs (window=%d)",
                                       provider, book_id, detail.error, current_backoff, len(rl_events))
                        yield {"type": "error", "message": f"Rate limited, backing off {current_backoff:.0f}s..."}
                    else:
                        logger.info("Series enrichment error for %s/%s: %s - retrying after %.1fs",
                                    provider, book_id, detail.error, current_backoff)
                    
                    # Sleep in slices, emitting keepalive pings so Traefik doesn't
                    # close the idle SSE connection during long/escalating backoffs.
                    sleep_remaining = current_backoff
                    while sleep_remaining > 0:
                        slice_s = min(PING_INTERVAL, sleep_remaining)
                        await asyncio.sleep(slice_s)
                        sleep_remaining -= slice_s
                        now = time.monotonic()
                        if now - last_ping > PING_INTERVAL:
                            yield {"type": "ping"}
                            last_ping = now
                    detail = await get_book(provider, book_id)
                    
                    if not detail.error:
                        # Recovered (blip or throttle cleared). Don't clear the window -
                        # let it expire naturally over RL_WINDOW_SECONDS. This avoids
                        # ping-ponging: if failures resume shortly after a lone success,
                        # the retained history still escalates instead of resetting to
                        # single 2s retries. current_backoff still resets on success
                        # (below), so throughput recovers immediately either way.
                        if rate_limited:
                            logger.info("Rate limit recovered after backoff for %s/%s", provider, book_id)
                        break
                    
                    # Still failing - re-evaluate the pattern (this retry may have added a hit)
                    rate_limited = note_and_check_rl(provider, detail.error)
                    
                    if not rate_limited:
                        # Lone / genuine error (real miss, HTTP 5xx, non-HC 404): skip it.
                        skipped_count += 1
                        logger.warning("Skipping book %s/%s due to error: %s (first: %s)",
                                       provider, book_id, detail.error, first_error)
                        book_skipped = True
                        break
                    
                    # Throttled - escalate backoff, or stop if exhausted at max.
                    if current_backoff >= MAX_BACKOFF:
                        retries_at_max_backoff += 1
                        if retries_at_max_backoff >= MAX_RETRIES_AT_MAX:
                            remaining = total - i - 1
                            logger.warning("Stopping enrichment: rate limit not recovering after %d attempts at max backoff. %d books remaining.",
                                           retries_at_max_backoff, remaining)
                            yield {"type": "error", "message": f"Stopped: provider rate limit ({remaining} books skipped)"}
                            book_skipped = True
                            break
                    else:
                        current_backoff = min(current_backoff * 2, MAX_BACKOFF)
                        logger.info("Increasing backoff to %.1fs", current_backoff)
                    # loop again: retry this same book after the (larger) backoff
                
                # Was this the stop condition? break out of the whole enrichment loop.
                if book_skipped and retries_at_max_backoff >= MAX_RETRIES_AT_MAX:
                    break
                # Book skipped (non-recoverable) - move on to the next book.
                if book_skipped:
                    continue
                # Otherwise detail.error is now clear (recovered) - fall through to caching.
            
            # Success - reset backoff state
            if current_backoff > INITIAL_BACKOFF:
                logger.info("Request succeeded, resetting backoff from %.1fs to %.1fs", current_backoff, INITIAL_BACKOFF)
                current_backoff = INITIAL_BACKOFF
                retries_at_max_backoff = 0
            
            # Cache the result (even if no series - avoids re-fetching)
            set_series_in_cache(
                provider, book_id,
                provider_id=detail.series_id,
                series_name=detail.series_name,
                series_position=detail.series_position,
                series_count=detail.series_count,
                isbn=detail.isbn,
            )
            
            # Persist to DB if hardcover provider and has series info
            if provider == "hardcover" and detail.series_name and detail.series_position is not None:
                try:
                    persisted = await persist_series_to_db(
                        hardcover_id=int(book_id),
                        series_name=detail.series_name,
                        series_position=detail.series_position,
                    )
                    if persisted:
                        logger.info("Persisted series '%s' pos=%s to DB for hardcover:%s", 
                                   detail.series_name, detail.series_position, book_id)
                except Exception as e:
                    logger.warning("Failed to persist series to DB for hardcover:%s: %s", book_id, e)
            
            if detail.series_position is not None:
                yield {
                    "type": "series",
                    "book_id": book_id,
                    "series_name": detail.series_name,
                    "series_position": detail.series_position,
                    "series_count": detail.series_count,
                }
        except Exception as e:
            error_count += 1
            skipped_count += 1
            logger.warning("Exception fetching series for %s/%s: %s", provider, book_id, e)
            # Don't stop on exceptions - just skip and continue
    
    elapsed = time.monotonic() - start_time
    logger.info("Series enrichment COMPLETE: %d/%d processed in %.1fs (%d cache hits, %d cache misses, %d errors, %d skipped, final cache size=%d)",
                total, total, elapsed, cache_hits, cache_misses, error_count, skipped_count, len(_series_cache))
    yield {"type": "done", "errors": error_count, "skipped": skipped_count}


async def queue_enrich_books(books: list[dict[str, str]]) -> dict[str, Any]:
    """Queue books for series enrichment and ensure the shared worker is running.

    - Skips books already cached or already queued (dedup).
    - PREPENDS new books so the current search is prioritized over older queued work.
    - Starts the single worker if it isn't already running.

    Returns a summary: how many were already cached, how many newly queued, queue size.
    """
    global _enrich_worker_task

    async with _enrich_lock:
        already_cached = 0
        newly_queued: list[dict[str, str]] = []

        for book in books:
            provider = book.get("provider")
            book_id = book.get("book_id")
            if not provider or not book_id:
                continue
            key = f"{provider}:{book_id}"
            if get_series_from_cache(provider, book_id) is not None:
                already_cached += 1
                continue
            if key in _enrich_queued_keys:
                continue  # already waiting in the queue
            newly_queued.append({"provider": provider, "book_id": book_id})

        # Prepend (prioritize the current search). Reverse so original order is
        # preserved once they sit at the front of the deque.
        for book in reversed(newly_queued):
            key = f"{book['provider']}:{book['book_id']}"
            _enrich_queue.appendleft(book)
            _enrich_queued_keys.add(key)

        # Ensure the single worker is running.
        if _enrich_worker_task is None or _enrich_worker_task.done():
            _enrich_worker_task = asyncio.create_task(_enrich_series_worker())

        return {
            "already_cached": already_cached,
            "queued": len(newly_queued),
            "queue_size": len(_enrich_queue),
        }


async def _enrich_series_worker() -> None:
    """The single shared enrichment worker. Drains _enrich_queue until empty.

    One worker => one request stream => the 2-in-60 rate-limit detection reflects
    the real request rate. Never start a second instance (see queue_enrich_books).
    """
    global _enrich_status

    # Rate limit handling constants
    INITIAL_BACKOFF = 2.0
    MAX_BACKOFF = 60.0
    MAX_RETRIES_AT_MAX = 3
    RL_WINDOW_SECONDS = 60.0
    RL_THRESHOLD = 3

    current_backoff = INITIAL_BACKOFF
    retries_at_max_backoff = 0
    rl_events: deque[float] = deque()
    processed = 0

    def note_and_check_rl(provider: str | None, error_str: str | None) -> bool:
        now = time.monotonic()
        while rl_events and now - rl_events[0] > RL_WINDOW_SECONDS:
            rl_events.popleft()
        if provider == "hardcover" and error_str == "Book not found":
            rl_events.append(now)
        return len(rl_events) >= RL_THRESHOLD

    _enrich_status.status = "running"
    _enrich_status.rate_limited = False
    _enrich_status.message = None
    start_time = time.monotonic()
    logger.info("Series enrichment worker START (queue=%d, cache size=%d)", len(_enrich_queue), len(_series_cache))

    try:
        while True:
            # Pull next book (front of queue = highest priority / newest search).
            try:
                book = _enrich_queue.popleft()
            except IndexError:
                break  # queue drained

            provider = book.get("provider")
            book_id = book.get("book_id")
            key = f"{provider}:{book_id}"
            _enrich_queued_keys.discard(key)

            if not provider or not book_id:
                continue

            # Skip if not in allowlist (testing mode)
            if _enrich_allowlist is not None and key not in _enrich_allowlist:
                logger.debug("Skipping %s (not in allowlist)", key)
                continue

            # Skip if it got cached since being queued.
            if get_series_from_cache(provider, book_id) is not None:
                continue

            logger.info("Cache miss for %s:%s (cache has %d entries)", provider, book_id, len(_series_cache))

            try:
                detail = await get_book(provider, book_id)

                if detail.error:
                    rate_limited = note_and_check_rl(provider, detail.error)
                    book_skipped = False

                    while detail.error:
                        if rate_limited:
                            logger.warning("Rate limit pattern detected for %s/%s: %s - backing off %.1fs",
                                           provider, book_id, detail.error, current_backoff)
                            _enrich_status.rate_limited = True
                            _enrich_status.message = f"Rate limited, backing off {current_backoff:.0f}s..."
                        else:
                            logger.info("Series enrichment error for %s/%s: %s - retrying after %.1fs",
                                        provider, book_id, detail.error, current_backoff)

                        await asyncio.sleep(current_backoff)
                        detail = await get_book(provider, book_id)

                        if not detail.error:
                            if rate_limited:
                                logger.info("Rate limit recovered after backoff for %s/%s", provider, book_id)
                                _enrich_status.rate_limited = False
                                _enrich_status.message = None
                            break

                        rate_limited = note_and_check_rl(provider, detail.error)

                        if not rate_limited:
                            logger.warning("Skipping book %s/%s due to error: %s", provider, book_id, detail.error)
                            book_skipped = True
                            break

                        if current_backoff >= MAX_BACKOFF:
                            retries_at_max_backoff += 1
                            if retries_at_max_backoff >= MAX_RETRIES_AT_MAX:
                                logger.warning("Rate limit not recovering after %d attempts at max backoff. "
                                               "Requeuing current book and pausing worker.", retries_at_max_backoff)
                                # Put the book back and stop; a later search restarts the worker.
                                _enrich_queue.appendleft(book)
                                _enrich_queued_keys.add(key)
                                _enrich_status.message = "Paused: provider rate limit"
                                raise _WorkerPaused()
                        else:
                            current_backoff = min(current_backoff * 2, MAX_BACKOFF)

                    if book_skipped:
                        processed += 1
                        _enrich_status.processed = processed
                        continue

                # Success - reset backoff
                if current_backoff > INITIAL_BACKOFF:
                    current_backoff = INITIAL_BACKOFF
                    retries_at_max_backoff = 0

                set_series_in_cache(
                    provider, book_id,
                    provider_id=detail.series_id,
                    series_name=detail.series_name,
                    series_position=detail.series_position,
                    series_count=detail.series_count,
                    isbn=detail.isbn,
                )

                if provider == "hardcover" and detail.series_name and detail.series_position is not None:
                    try:
                        await persist_series_to_db(
                            hardcover_id=int(book_id),
                            series_name=detail.series_name,
                            series_position=detail.series_position,
                        )
                    except Exception as e:
                        logger.warning("Failed to persist series to DB for hardcover:%s: %s", book_id, e)

            except _WorkerPaused:
                raise
            except Exception as e:
                logger.warning("Exception fetching series for %s/%s: %s", provider, book_id, e)

            processed += 1
            _enrich_status.processed = processed

        elapsed = time.monotonic() - start_time
        logger.info("Series enrichment worker COMPLETE: processed %d in %.1fs (cache size=%d)",
                    processed, elapsed, len(_series_cache))

    except _WorkerPaused:
        elapsed = time.monotonic() - start_time
        logger.warning("Series enrichment worker PAUSED after %d processed in %.1fs (%d still queued)",
                       processed, elapsed, len(_enrich_queue))
    except Exception as e:
        logger.exception("Series enrichment worker FAILED: %s", e)
    finally:
        _enrich_status.status = "idle"
        _enrich_status.rate_limited = False


class _WorkerPaused(Exception):
    """Internal signal: worker stopped early due to unrecovered rate limiting."""
    pass


async def get_shelfmark_url() -> str | None:
    """Get the configured Shelfmark base URL."""
    settings = await _get_settings()
    return settings["url"] or None


async def test_connection(
    url: str | None = None,
    username: str | None = None,
    password: str | None = None,
) -> dict[str, Any]:
    """
    Test the connection to Shelfmark.
    
    Args:
        url: Optional URL override (uses saved setting if not provided)
        username: Optional username override
        password: Optional password override
    
    Returns:
        Dict with connection status and any error message
    """
    settings = await _get_settings()
    
    # Use provided values or fall back to saved settings
    test_url = url or settings["url"]
    test_username = username or settings["username"]
    test_password = password or settings["password"]
    
    if not test_url:
        return {"connected": False, "error": "Shelfmark URL not configured"}
    if not test_username:
        return {"connected": False, "error": "Shelfmark username not configured"}
    if not test_password:
        return {"connected": False, "error": "Shelfmark password not configured"}
    
    try:
        # Try to login with the provided/saved credentials
        async with httpx.AsyncClient(timeout=30.0) as client:
            cookies = await _login(client, test_url, test_username, test_password)
        
        # If we got here, login succeeded
        return {"connected": True, "url": test_url}
    except ShelfmarkError as e:
        return {"connected": False, "error": str(e)}
    except Exception as e:
        logger.exception("Shelfmark connection test failed")
        return {"connected": False, "error": str(e)}


@dataclass
class ShelfmarkRelease:
    """A single release/download option from Shelfmark."""
    source: str
    source_id: str
    title: str
    author: str | None
    format: str | None
    size: str | None
    language: str | None
    indexer: str | None
    cover_url: str | None
    info_url: str | None


@dataclass
class ShelfmarkBookInfo:
    """Book metadata from releases response."""
    title: str
    author: str | None
    description: str | None
    cover_url: str | None
    year: int | None
    isbn: str | None
    source_url: str | None
    provider: str | None
    provider_id: str | None
    # Series info (from SM metadata provider)
    series_name: str | None = None
    series_position: float | None = None


@dataclass
class ShelfmarkReleasesResponse:
    """Response from fetching releases for a book."""
    book: ShelfmarkBookInfo | None
    releases: list[ShelfmarkRelease]
    sources: list[str]  # Unique source types (for tabs)
    error: str | None = None


@dataclass
class ShelfmarkBookDetailResponse:
    """Full book details from metadata provider."""
    id: str
    title: str
    author: str | None
    description: str | None
    cover_url: str | None
    year: int | None
    isbn: str | None
    source_url: str | None
    provider: str | None
    provider_display_name: str | None
    # Series info
    series_id: str | None = None
    series_name: str | None = None
    series_position: float | None = None
    series_count: int | None = None
    # Additional metadata
    genres: list[str] | None = None
    publisher: str | None = None
    language: str | None = None
    # Display fields (rating, readers, etc.)
    display_fields: list[dict] | None = None
    error: str | None = None


async def get_book(provider: str, book_id: str) -> ShelfmarkBookDetailResponse:
    """
    Fetch full book details from Shelfmark's metadata provider.
    
    This calls GET /api/metadata/book/{provider}/{book_id} which returns
    detailed book info including description, series info, genres, etc.
    that are not included in search results.
    
    Args:
        provider: Metadata provider (e.g., "hardcover", "googlebooks", "openlibrary")
        book_id: Provider-specific book ID
    
    Returns:
        ShelfmarkBookDetailResponse with full book metadata
    """
    try:
        cookies = await _get_authenticated_session()
        api_url = await get_internal_url()
        browser_url = await get_external_url()
    except ShelfmarkError as e:
        return ShelfmarkBookDetailResponse(
            id=book_id,
            title="Unknown",
            author=None,
            description=None,
            cover_url=None,
            year=None,
            isbn=None,
            source_url=None,
            provider=provider,
            provider_display_name=None,
            error=str(e),
        )
    
    book_url = f"{api_url.rstrip('/')}/api/metadata/book/{provider}/{book_id}"
    
    # Rate limit check: enrichment worker waits if at limit
    await _hc_rate_limiter.acquire(block=True)
    
    try:
        async with httpx.AsyncClient(timeout=30.0, cookies=cookies) as client:
            resp = await client.get(book_url)
            
            if resp.status_code == 401:
                logger.info("Shelfmark session expired during book fetch, re-authenticating")
                clear_session_cache()
                cookies = await _get_authenticated_session()
                async with httpx.AsyncClient(timeout=30.0, cookies=cookies) as retry_client:
                    resp = await retry_client.get(book_url)
            
            if resp.status_code == 404:
                return ShelfmarkBookDetailResponse(
                    id=book_id,
                    title="Unknown",
                    author=None,
                    description=None,
                    cover_url=None,
                    year=None,
                    isbn=None,
                    source_url=None,
                    provider=provider,
                    provider_display_name=None,
                    error="Book not found",
                )
            
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as e:
        logger.error("Shelfmark book detail HTTP error: %s", e.response.status_code)
        return ShelfmarkBookDetailResponse(
            id=book_id,
            title="Unknown",
            author=None,
            description=None,
            cover_url=None,
            year=None,
            isbn=None,
            source_url=None,
            provider=provider,
            provider_display_name=None,
            error=f"HTTP {e.response.status_code}",
        )
    except Exception as e:
        logger.error("Shelfmark book detail error: %s", e)
        return ShelfmarkBookDetailResponse(
            id=book_id,
            title="Unknown",
            author=None,
            description=None,
            cover_url=None,
            year=None,
            isbn=None,
            source_url=None,
            provider=provider,
            provider_display_name=None,
            error=str(e),
        )
    
    # Parse response - SM returns a flat dict with book details
    # Cover URL needs browser URL for frontend access
    cover_url = data.get("cover_url")
    if cover_url and cover_url.startswith("/"):
        cover_url = f"{browser_url.rstrip('/')}{cover_url}"
    
    # Extract author - SM may return authors as array or string
    author = data.get("author")
    if not author:
        authors_list = data.get("authors") or data.get("author_names")
        if authors_list and isinstance(authors_list, list) and len(authors_list) > 0:
            author = str(authors_list[0])
    
    # ISBN - prefer isbn_13 over isbn_10
    isbn = data.get("isbn_13") or data.get("isbn_10") or data.get("isbn")
    
    # Provider display name
    provider_display = data.get("provider_display_name")
    if not provider_display and provider:
        provider_display = provider.replace("_", " ").title()
        if provider == "hardcover":
            provider_display = "Hardcover"
        elif provider == "googlebooks":
            provider_display = "Google Books"
        elif provider == "openlibrary":
            provider_display = "Open Library"
    
    # Truncate description for logging (can be huge)
    desc = data.get("description")
    desc_log = f"{desc[:80]}..." if desc and len(desc) > 80 else desc
    
    logger.info("Shelfmark book detail fetched: provider=%s book_id=%s title=%r desc=%r series=%s source_url=%r", 
                provider, book_id, data.get("title"), 
                desc_log,
                data.get("series_name"),
                data.get("source_url"))
    
    # Fix source_url for Google Books - SM returns a Play Store URL that doesn't work
    # Construct a proper Google Books URL instead
    source_url = data.get("source_url")
    if provider == "googlebooks" and book_id:
        source_url = f"https://books.google.com/books?id={book_id}"
    
    return ShelfmarkBookDetailResponse(
        id=data.get("id", book_id),
        title=data.get("title", "Unknown"),
        author=author,
        description=data.get("description"),
        cover_url=cover_url,
        year=data.get("year") or data.get("publish_year"),
        isbn=isbn,
        source_url=source_url,
        provider=provider,
        provider_display_name=provider_display,
        series_id=data.get("series_id"),
        series_name=data.get("series_name"),
        series_position=data.get("series_position"),
        series_count=data.get("series_count"),
        genres=data.get("genres"),
        publisher=data.get("publisher"),
        language=data.get("language"),
        display_fields=data.get("display_fields"),
    )


async def get_releases(
    provider: str,
    book_id: str,
    manual_query: str | None = None,
) -> ShelfmarkReleasesResponse:
    """
    Fetch available releases for a book from Shelfmark.
    
    This calls GET /api/releases?provider=X&book_id=Y which can take
    a long time (30s+) as SM waits for Cloudflare etc.
    
    Args:
        provider: Metadata provider (e.g., "googlebooks", "hardcover")
        book_id: Provider-specific book ID
        manual_query: Optional manual search query (bypasses SM's metadata-based search)
    
    Returns:
        ShelfmarkReleasesResponse with book info and releases
    """
    try:
        cookies = await _get_authenticated_session()
        api_url = await get_internal_url()
        browser_url = await get_external_url()
    except ShelfmarkError as e:
        return ShelfmarkReleasesResponse(
            book=None,
            releases=[],
            sources=[],
            error=str(e),
        )
    
    releases_url = f"{api_url.rstrip('/')}/api/releases"
    params: dict[str, str] = {
        "provider": provider,
        "book_id": book_id,
    }
    
    # Add manual_query for direct search (overrides SM's metadata-based search)
    if manual_query:
        params["manual_query"] = manual_query
    
    try:
        # Long timeout - SM can take 2-3 min waiting for Cloudflare bypasses
        async with httpx.AsyncClient(timeout=180.0, cookies=cookies) as client:
            resp = await client.get(releases_url, params=params)
            
            if resp.status_code == 401:
                logger.info("Shelfmark session expired during releases fetch, re-authenticating")
                clear_session_cache()
                cookies = await _get_authenticated_session()
                async with httpx.AsyncClient(timeout=180.0, cookies=cookies) as retry_client:
                    resp = await retry_client.get(releases_url, params=params)
            
            resp.raise_for_status()
            data = resp.json()
    except httpx.TimeoutException:
        logger.error("Shelfmark releases request timed out after 180s")
        return ShelfmarkReleasesResponse(
            book=None,
            releases=[],
            sources=[],
            error="Request timed out. Shelfmark may still be processing - wait 30 seconds before retrying.",
        )
    except httpx.HTTPStatusError as e:
        logger.error("Shelfmark releases HTTP error: %s", e.response.status_code)
        return ShelfmarkReleasesResponse(
            book=None,
            releases=[],
            sources=[],
            error=f"Failed to fetch releases: HTTP {e.response.status_code}",
        )
    except httpx.HTTPError as e:
        logger.error("Shelfmark releases error: %s", e)
        return ShelfmarkReleasesResponse(
            book=None,
            releases=[],
            sources=[],
            error=f"Failed to fetch releases: {e}",
        )
    except ShelfmarkError as e:
        return ShelfmarkReleasesResponse(
            book=None,
            releases=[],
            sources=[],
            error=str(e),
        )
    
    # Parse book info
    book_data = data.get("book", {})
    # Log book data to debug author field
    logger.info("Shelfmark releases book data: authors=%r", book_data.get("authors"))
    # Use first author only to avoid narrator pollution in audiobooks
    book_authors = book_data.get("authors", [])
    if isinstance(book_authors, list) and book_authors:
        book_author = str(book_authors[0])
    elif isinstance(book_authors, str):
        book_author = book_authors
    else:
        book_author = None
    
    book_cover = book_data.get("cover_url")
    if book_cover and book_cover.startswith("/"):
        book_cover = f"{browser_url.rstrip('/')}{book_cover}"
    
    book_info = ShelfmarkBookInfo(
        title=book_data.get("title", "Unknown"),
        author=book_author if book_author else None,
        description=book_data.get("description"),
        cover_url=book_cover,
        year=book_data.get("publish_year"),
        isbn=book_data.get("isbn_13") or book_data.get("isbn_10"),
        source_url=book_data.get("source_url"),
        provider=book_data.get("provider"),
        provider_id=book_data.get("provider_id"),
        series_name=book_data.get("series_name"),
        series_position=book_data.get("series_position"),
    )
    
    # Parse releases
    releases = []
    source_set: set[str] = set()
    
    for item in data.get("releases", []):
        source = item.get("source", "unknown")
        source_set.add(source)
        
        # Author from extra data
        extra = item.get("extra", {})
        author = extra.get("author", "")
        
        # Cover URL
        cover = extra.get("preview")
        if cover and cover.startswith("/"):
            cover = f"{browser_url.rstrip('/')}{cover}"
        
        releases.append(ShelfmarkRelease(
            source=source,
            source_id=item.get("source_id", ""),
            title=item.get("title", "Unknown"),
            author=author if author else None,
            format=item.get("format"),
            size=item.get("size"),
            language=item.get("language") or extra.get("language"),
            indexer=item.get("indexer"),
            cover_url=cover,
            info_url=item.get("info_url"),
        ))
    
    # Sort sources for consistent tab order
    sources = sorted(source_set)
    
    logger.info("Shelfmark releases fetched: provider=%s book_id=%s releases=%d sources=%s",
                provider, book_id, len(releases), sources)
    
    return ShelfmarkReleasesResponse(
        book=book_info,
        releases=releases,
        sources=sources,
    )


@dataclass
class ShelfmarkDownloadResponse:
    """Response from initiating a download."""
    success: bool
    status: str | None = None
    priority: int | None = None
    error: str | None = None


@dataclass
class ShelfmarkDownloadStatus:
    """Status of a download in progress."""
    source_id: str
    title: str
    author: str | None
    status: str  # resolving, locating, downloading, complete, error, cancelled
    status_message: str | None
    progress: float  # 0.0 to 1.0
    source: str
    source_display_name: str | None
    format: str | None
    size: str | None
    cover_url: str | None


@dataclass  
class ShelfmarkStatusResponse:
    """Response from status endpoint."""
    in_progress: list[ShelfmarkDownloadStatus]
    complete: list[ShelfmarkDownloadStatus]
    failed: list[ShelfmarkDownloadStatus]
    error: str | None = None


async def get_download_status() -> ShelfmarkStatusResponse:
    """
    Get current download status from Shelfmark.
    
    Calls GET /api/status to get all downloads (in progress, complete, failed).
    """
    try:
        cookies = await _get_authenticated_session()
        api_url = await get_internal_url()
        browser_url = await get_external_url()
    except ShelfmarkError as e:
        return ShelfmarkStatusResponse(in_progress=[], complete=[], failed=[], error=str(e))
    
    status_url = f"{api_url.rstrip('/')}/api/status"
    
    try:
        async with httpx.AsyncClient(timeout=10.0, cookies=cookies) as client:
            resp = await client.get(status_url)
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPError as e:
        logger.error("Shelfmark status error: %s", e)
        return ShelfmarkStatusResponse(in_progress=[], complete=[], failed=[], error=str(e))
    
    # Helper to parse download item
    def parse_download_item(source_id: str, item: dict, status_type: str) -> ShelfmarkDownloadStatus:
        cover = item.get("preview")
        if cover and cover.startswith("/"):
            cover = f"{browser_url.rstrip('/')}{cover}"
        return ShelfmarkDownloadStatus(
            source_id=source_id,
            title=item.get("title", "Unknown"),
            author=item.get("author"),
            status=item.get("status", status_type),
            status_message=item.get("status_message"),
            progress=item.get("progress", 0.0),
            source=item.get("source", ""),
            source_display_name=item.get("source_display_name"),
            format=item.get("format"),
            size=item.get("size"),
            cover_url=cover,
        )
    
    # Collect in-progress downloads (queued, resolving, locating, downloading)
    in_progress = []
    for status_type in ["queued", "resolving", "locating", "downloading"]:
        items = data.get(status_type, {})
        for source_id, item in items.items():
            in_progress.append(parse_download_item(source_id, item, status_type))
    
    # Collect complete downloads
    complete = []
    for source_id, item in data.get("complete", {}).items():
        complete.append(parse_download_item(source_id, item, "complete"))
    
    # Collect failed downloads (error and cancelled)
    failed = []
    for status_type in ["error", "cancelled"]:
        items = data.get(status_type, {})
        for source_id, item in items.items():
            failed.append(parse_download_item(source_id, item, status_type))
    
    return ShelfmarkStatusResponse(in_progress=in_progress, complete=complete, failed=failed)


async def initiate_download(
    source: str,
    source_id: str,
    title: str | None = None,
    author: str | None = None,
    format: str | None = None,
    size: str | None = None,
    cover_url: str | None = None,
    book_title: str | None = None,
    book_author: str | None = None,
    book_year: int | None = None,
    book_provider: str | None = None,
    book_provider_id: str | None = None,
    series_name: str | None = None,
    series_position: float | None = None,
) -> ShelfmarkDownloadResponse:
    """
    Initiate a download in Shelfmark.
    
    Calls POST /api/releases/download with release and book metadata.
    
    Args:
        source: Source type (e.g., "direct_download", "prowlarr")
        source_id: Source-specific release ID
        title: Release title
        author: Release author
        format: File format (epub, pdf, etc.)
        size: File size string
        cover_url: Cover image URL
        book_title: Book title from metadata search
        book_author: Book author from metadata search  
        book_year: Publication year
        book_provider: Metadata provider (e.g., "googlebooks")
        book_provider_id: Provider-specific book ID
        series_name: Series name for folder naming
        series_position: Position in series for folder naming
    
    Returns:
        ShelfmarkDownloadResponse with status
    """
    try:
        cookies = await _get_authenticated_session()
        api_url = await get_internal_url()
    except ShelfmarkError as e:
        return ShelfmarkDownloadResponse(
            success=False,
            error=str(e),
        )
    
    download_url = f"{api_url.rstrip('/')}/api/releases/download"
    
    # Build payload with all available metadata
    # Use book metadata preferentially for title/author since it's cleaner
    payload: dict[str, Any] = {
        "source": source,
        "source_id": source_id,
    }
    
    # Title - prefer book title over release title
    if book_title:
        payload["title"] = book_title
    elif title:
        payload["title"] = title
    
    # Author - prefer book author (First Last format) over release author (Last, First)
    if book_author:
        payload["author"] = book_author
    elif author:
        payload["author"] = author
    
    if format:
        payload["format"] = format
    if size:
        payload["size"] = size
    if cover_url:
        payload["preview"] = cover_url
    
    # Additional book metadata that SM may use for post-processing
    if book_year:
        payload["year"] = book_year
    if book_provider:
        payload["provider"] = book_provider
    if book_provider_id:
        payload["provider_id"] = book_provider_id
    
    # Series metadata for folder naming templates
    if series_name:
        payload["series_name"] = series_name
    if series_position is not None:
        payload["series_position"] = series_position
    
    try:
        async with httpx.AsyncClient(timeout=30.0, cookies=cookies) as client:
            resp = await client.post(download_url, json=payload)
            
            if resp.status_code == 401:
                logger.info("Shelfmark session expired during download, re-authenticating")
                clear_session_cache()
                cookies = await _get_authenticated_session()
                async with httpx.AsyncClient(timeout=30.0, cookies=cookies) as retry_client:
                    resp = await retry_client.post(download_url, json=payload)
            
            data = resp.json()
            
            # SM returns 500 for soft errors like "already in queue" - extract actual message
            if resp.status_code >= 400:
                error_msg = data.get("error", f"HTTP {resp.status_code}")
                logger.warning("Shelfmark download rejected: %s", error_msg)
                return ShelfmarkDownloadResponse(
                    success=False,
                    error=error_msg,
                )
    except httpx.HTTPStatusError as e:
        # Try to extract error from response body
        try:
            data = e.response.json()
            error_msg = data.get("error", f"HTTP {e.response.status_code}")
        except Exception:
            error_msg = f"Download failed: HTTP {e.response.status_code}"
        logger.error("Shelfmark download HTTP error: %s - %s", e.response.status_code, error_msg)
        return ShelfmarkDownloadResponse(
            success=False,
            error=error_msg,
        )
    except httpx.HTTPError as e:
        logger.error("Shelfmark download error: %s", e)
        return ShelfmarkDownloadResponse(
            success=False,
            error=f"Download failed: {e}",
        )
    except ShelfmarkError as e:
        return ShelfmarkDownloadResponse(
            success=False,
            error=str(e),
        )
    
    logger.info("Shelfmark download initiated: source=%s source_id=%s status=%s",
                source, source_id, data.get("status"))
    
    return ShelfmarkDownloadResponse(
        success=True,
        status=data.get("status"),
        priority=data.get("priority"),
    )


@dataclass
class ShelfmarkCancelResponse:
    """Response from canceling a download."""
    success: bool
    error: str | None = None


async def cancel_download(source_id: str) -> ShelfmarkCancelResponse:
    """
    Cancel a download in Shelfmark.
    
    Calls DELETE /api/download/<source_id>/cancel.
    
    Args:
        source_id: The source ID of the download to cancel
    
    Returns:
        ShelfmarkCancelResponse with status
    """
    try:
        cookies = await _get_authenticated_session()
        api_url = await get_internal_url()
    except ShelfmarkError as e:
        return ShelfmarkCancelResponse(success=False, error=str(e))
    
    cancel_url = f"{api_url.rstrip('/')}/api/download/{source_id}/cancel"
    
    try:
        async with httpx.AsyncClient(timeout=30.0, cookies=cookies) as client:
            resp = await client.delete(cancel_url)
            
            if resp.status_code == 401:
                logger.info("Shelfmark session expired during cancel, re-authenticating")
                clear_session_cache()
                cookies = await _get_authenticated_session()
                async with httpx.AsyncClient(timeout=30.0, cookies=cookies) as retry_client:
                    resp = await retry_client.delete(cancel_url)
            
            if resp.status_code == 404:
                return ShelfmarkCancelResponse(success=False, error="Download not found")
            
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as e:
        logger.error("Shelfmark cancel HTTP error: %s", e.response.status_code)
        return ShelfmarkCancelResponse(success=False, error=f"Cancel failed: HTTP {e.response.status_code}")
    except httpx.HTTPError as e:
        logger.error("Shelfmark cancel error: %s", e)
        return ShelfmarkCancelResponse(success=False, error=f"Cancel failed: {e}")
    except ShelfmarkError as e:
        return ShelfmarkCancelResponse(success=False, error=str(e))
    
    logger.info("Shelfmark download cancelled: source_id=%s", source_id)
    
    return ShelfmarkCancelResponse(success=True)


@dataclass
class ShelfmarkRetryResponse:
    """Response from retry endpoint."""
    success: bool
    error: str | None = None


async def retry_download(source_id: str) -> ShelfmarkRetryResponse:
    """
    Retry a failed download in Shelfmark.
    
    Calls POST /api/download/<source_id>/retry.
    
    Args:
        source_id: The source ID of the download to retry
    
    Returns:
        ShelfmarkRetryResponse with status
    """
    try:
        cookies = await _get_authenticated_session()
        api_url = await get_internal_url()
    except ShelfmarkError as e:
        return ShelfmarkRetryResponse(success=False, error=str(e))
    
    retry_url = f"{api_url.rstrip('/')}/api/download/{source_id}/retry"
    
    try:
        async with httpx.AsyncClient(timeout=30.0, cookies=cookies) as client:
            resp = await client.post(retry_url)
            
            if resp.status_code == 401:
                logger.info("Shelfmark session expired during retry, re-authenticating")
                clear_session_cache()
                cookies = await _get_authenticated_session()
                async with httpx.AsyncClient(timeout=30.0, cookies=cookies) as retry_client:
                    resp = await retry_client.post(retry_url)
            
            if resp.status_code == 404:
                return ShelfmarkRetryResponse(success=False, error="Download not found")
            
            resp.raise_for_status()
    except httpx.HTTPStatusError as e:
        logger.error("Shelfmark retry HTTP error: %s", e.response.status_code)
        return ShelfmarkRetryResponse(success=False, error=f"Retry failed: HTTP {e.response.status_code}")
    except httpx.HTTPError as e:
        logger.error("Shelfmark retry error: %s", e)
        return ShelfmarkRetryResponse(success=False, error=f"Retry failed: {e}")
    except ShelfmarkError as e:
        return ShelfmarkRetryResponse(success=False, error=str(e))
    
    logger.info("Shelfmark download retry initiated: source_id=%s", source_id)
    
    return ShelfmarkRetryResponse(success=True)


@dataclass
class ShelfmarkDismissResponse:
    """Response from dismiss endpoint."""
    success: bool
    error: str | None = None


async def dismiss_download(source_id: str) -> ShelfmarkDismissResponse:
    """
    Dismiss a completed/failed download from Shelfmark's activity view.
    
    Calls POST /api/activity/dismiss to hide the download from the queue.
    
    Args:
        source_id: The source ID of the download to dismiss
    
    Returns:
        ShelfmarkDismissResponse with status
    """
    try:
        cookies = await _get_authenticated_session()
        api_url = await get_internal_url()
    except ShelfmarkError as e:
        return ShelfmarkDismissResponse(success=False, error=str(e))
    
    dismiss_url = f"{api_url.rstrip('/')}/api/activity/dismiss"
    
    try:
        async with httpx.AsyncClient(timeout=30.0, cookies=cookies) as client:
            resp = await client.post(dismiss_url, json={
                "item_type": "download",
                "item_key": f"download:{source_id}",
            })
            
            if resp.status_code == 401:
                logger.info("Shelfmark session expired during dismiss, re-authenticating")
                clear_session_cache()
                cookies = await _get_authenticated_session()
                async with httpx.AsyncClient(timeout=30.0, cookies=cookies) as retry_client:
                    resp = await retry_client.post(dismiss_url, json={
                        "item_type": "download",
                        "item_key": f"download:{source_id}",
                    })
            
            resp.raise_for_status()
    except httpx.HTTPStatusError as e:
        logger.error("Shelfmark dismiss HTTP error: %s", e.response.status_code)
        return ShelfmarkDismissResponse(success=False, error=f"Dismiss failed: HTTP {e.response.status_code}")
    except httpx.HTTPError as e:
        logger.error("Shelfmark dismiss error: %s", e)
        return ShelfmarkDismissResponse(success=False, error=f"Dismiss failed: {e}")
    except ShelfmarkError as e:
        return ShelfmarkDismissResponse(success=False, error=str(e))
    
    logger.info("Shelfmark download dismissed: source_id=%s", source_id)
    
    return ShelfmarkDismissResponse(success=True)


async def dismiss_many_downloads(source_ids: list[str]) -> ShelfmarkDismissResponse:
    """
    Dismiss multiple completed/failed downloads from Shelfmark's activity view.
    
    Calls POST /api/activity/dismiss-many to hide downloads from the queue.
    
    Args:
        source_ids: List of source IDs to dismiss
    
    Returns:
        ShelfmarkDismissResponse with status
    """
    if not source_ids:
        return ShelfmarkDismissResponse(success=True)
    
    try:
        cookies = await _get_authenticated_session()
        api_url = await get_internal_url()
    except ShelfmarkError as e:
        return ShelfmarkDismissResponse(success=False, error=str(e))
    
    dismiss_url = f"{api_url.rstrip('/')}/api/activity/dismiss-many"
    items = [{"item_type": "download", "item_key": f"download:{sid}"} for sid in source_ids]
    
    try:
        async with httpx.AsyncClient(timeout=30.0, cookies=cookies) as client:
            resp = await client.post(dismiss_url, json={"items": items})
            
            if resp.status_code == 401:
                logger.info("Shelfmark session expired during dismiss-many, re-authenticating")
                clear_session_cache()
                cookies = await _get_authenticated_session()
                async with httpx.AsyncClient(timeout=30.0, cookies=cookies) as retry_client:
                    resp = await retry_client.post(dismiss_url, json={"items": items})
            
            resp.raise_for_status()
    except httpx.HTTPStatusError as e:
        logger.error("Shelfmark dismiss-many HTTP error: %s", e.response.status_code)
        return ShelfmarkDismissResponse(success=False, error=f"Dismiss failed: HTTP {e.response.status_code}")
    except httpx.HTTPError as e:
        logger.error("Shelfmark dismiss-many error: %s", e)
        return ShelfmarkDismissResponse(success=False, error=f"Dismiss failed: {e}")
    except ShelfmarkError as e:
        return ShelfmarkDismissResponse(success=False, error=str(e))
    
    logger.info("Shelfmark downloads dismissed: count=%d", len(source_ids))
    
    return ShelfmarkDismissResponse(success=True)
