"""Audiobookshelf integration service for syncing metadata."""

import json
import logging
from dataclasses import dataclass

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.config import ABS_URL, ABS_API_KEY, ABS_LIBRARY_ID, CONFIG_DIR
from backend.app.models import Author, Book, Setting
from backend.app.services.image_cache import cache_author_image, cache_book_cover
from backend.app.utils.api_usage import begin_api_usage_batch, clear_api_usage_batch, flush_api_usage_batch

logger = logging.getLogger("booksarr.abs_sync")

# Internal Docker hostname for faster API calls (internal port is 80)
_INTERNAL_ABS_URL = "http://audiobookshelf:80"

# Cached working URL (None = not tested yet)
_cached_abs_url: str | None = None


async def get_internal_url(configured_url: str, api_key: str) -> str:
    """Get the internal URL for backend API calls.
    
    Tries internal Docker URL first, falls back to configured URL.
    Result is cached for app lifetime (only tests once).
    """
    global _cached_abs_url
    
    # Return cached result if we've already tested
    if _cached_abs_url is not None:
        return _cached_abs_url
    
    headers = {"Authorization": f"Bearer {api_key}"}
    
    # Try internal Docker URL first
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            resp = await client.get(f"{_INTERNAL_ABS_URL}/ping", headers=headers)
            if resp.status_code == 200:
                logger.info("Using internal ABS URL: %s", _INTERNAL_ABS_URL)
                _cached_abs_url = _INTERNAL_ABS_URL
                return _cached_abs_url
    except Exception:
        pass
    
    # Internal doesn't work, use configured
    logger.info("Using configured ABS URL: %s", configured_url)
    _cached_abs_url = configured_url
    return _cached_abs_url


def get_external_url(configured_url: str) -> str:
    """Get the external URL for browser-accessible links.
    
    Returns the configured URL (what the user set in settings).
    """
    return configured_url.rstrip("/")


@dataclass
class AbsAuthor:
    id: str
    name: str
    asin: str | None
    description: str | None
    image_path: str | None


@dataclass
class AbsBook:
    """Represents an audiobook from ABS."""
    id: str
    title: str
    author_name: str | None
    asin: str | None
    isbn: str | None
    rel_path: str
    has_cover: bool
    cover_path: str | None


@dataclass
class AbsSyncStatus:
    status: str  # idle, syncing, completed, failed
    total_authors: int = 0
    total_books: int = 0
    authors_processed: int = 0
    authors_updated: int = 0
    authors_skipped: int = 0
    authors_failed: int = 0
    books_processed: int = 0
    books_updated: int = 0
    books_skipped: int = 0
    books_failed: int = 0
    message: str = ""


# Global sync status
_sync_status = AbsSyncStatus(status="idle")


def get_sync_status() -> AbsSyncStatus:
    return _sync_status


async def get_abs_settings(db: AsyncSession) -> tuple[str, str, str, bool, bool]:
    """Get ABS settings from DB or environment.
    
    Returns: (url, api_key, library_id, enabled, prefer_abs_metadata)
    """
    result = await db.execute(select(Setting))
    settings = {s.key: s.value for s in result.scalars().all()}
    
    url = settings.get("abs_url", "") or ABS_URL
    api_key = settings.get("abs_api_key", "") or ABS_API_KEY
    library_id = settings.get("abs_library_id", "") or ABS_LIBRARY_ID
    enabled = settings.get("abs_enabled", "false").lower() == "true"
    prefer_abs = settings.get("prefer_abs_metadata", "false").lower() == "true"
    
    return url, api_key, library_id, enabled, prefer_abs


async def fetch_abs_authors(url: str, api_key: str, library_id: str) -> list[AbsAuthor]:
    """Fetch all authors from ABS library."""
    # Use internal URL for speed
    url = await get_internal_url(url, api_key)
    url = url.rstrip("/")
    headers = {"Authorization": f"Bearer {api_key}"}
    
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(f"{url}/api/libraries/{library_id}/authors", headers=headers)
        
        if resp.status_code != 200:
            logger.warning("Failed to fetch ABS authors: status %d", resp.status_code)
            return []
        
        data = resp.json()
        authors = []
        
        for author_data in data.get("authors", []):
            authors.append(AbsAuthor(
                id=author_data["id"],
                name=author_data["name"],
                asin=author_data.get("asin"),
                description=author_data.get("description"),
                image_path=author_data.get("imagePath"),
            ))
        
        return authors


async def fetch_abs_books(url: str, api_key: str, library_id: str) -> list[AbsBook]:
    """Fetch all audiobooks from ABS library."""
    url = await get_internal_url(url, api_key)
    url = url.rstrip("/")
    headers = {"Authorization": f"Bearer {api_key}"}
    
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.get(
            f"{url}/api/libraries/{library_id}/items",
            headers=headers,
            params={"limit": 0}  # Get all items
        )
        
        if resp.status_code != 200:
            logger.warning("Failed to fetch ABS books: status %d", resp.status_code)
            return []
        
        data = resp.json()
        books = []
        
        for item_data in data.get("results", []):
            media = item_data.get("media", {})
            metadata = media.get("metadata", {})
            
            # Get author name - could be string or list
            author_name = metadata.get("authorName") or metadata.get("author")
            if isinstance(author_name, list):
                author_name = author_name[0] if author_name else None
            
            books.append(AbsBook(
                id=item_data["id"],
                title=metadata.get("title", ""),
                author_name=author_name,
                asin=metadata.get("asin"),
                isbn=metadata.get("isbn"),
                rel_path=item_data.get("relPath", ""),
                has_cover=bool(media.get("coverPath")),
                cover_path=media.get("coverPath"),
            ))
        
        return books


def normalize_author_name(name: str) -> str:
    """Normalize author name for matching."""
    # Remove common suffixes, lowercase, strip whitespace
    name = name.lower().strip()
    # Remove Jr., Sr., III, etc.
    for suffix in [" jr.", " sr.", " jr", " sr", " iii", " ii", " iv"]:
        if name.endswith(suffix):
            name = name[:-len(suffix)]
    return name


async def sync_author_from_abs(
    author: Author,
    abs_url: str,
    abs_api_key: str,
    abs_authors: list[AbsAuthor],
    prefer_abs: bool = False,
) -> bool:
    """Sync author data from ABS (ID, ASIN, image).
    
    Returns True if any data was updated.
    """
    # Find matching ABS author by name
    normalized_name = normalize_author_name(author.name)
    matching_abs_author = None
    
    for abs_author in abs_authors:
        if normalize_author_name(abs_author.name) == normalized_name:
            matching_abs_author = abs_author
            break
    
    if not matching_abs_author:
        return False
    
    updated = False
    
    # Always update ABS author ID if we have a match
    if author.abs_author_id != matching_abs_author.id:
        author.abs_author_id = matching_abs_author.id
        updated = True
    
    # Update ASIN if ABS has one and we don't (or prefer ABS)
    if matching_abs_author.asin and (not author.asin or prefer_abs):
        author.asin = matching_abs_author.asin
        updated = True
    
    # Sync image if ABS has one and we don't (or prefer ABS)
    if matching_abs_author.image_path:
        if not author.image_cached_path or prefer_abs:
            # Use internal URL for image download (faster)
            internal_url = await get_internal_url(abs_url, abs_api_key)
            internal_url = internal_url.rstrip("/")
            image_url = f"{internal_url}/api/authors/{matching_abs_author.id}/image"
            
            try:
                cached_path = await cache_author_image(
                    author.id,
                    image_url,
                    source="abs",
                    overwrite=prefer_abs,
                    auth_header=f"Bearer {abs_api_key}",
                )
                
                if cached_path:
                    author.image_url = image_url
                    author.image_cached_path = cached_path
                    logger.info("Synced ABS author image for %s", author.name)
                    updated = True
            except Exception as e:
                logger.warning("Failed to cache ABS author image for %s: %s", author.name, e)
    
    if updated:
        logger.debug("Synced author %s from ABS (id=%s, asin=%s)", 
                    author.name, matching_abs_author.id, matching_abs_author.asin)
    
    return updated


async def sync_book_from_abs(
    book: Book,
    abs_url: str,
    abs_api_key: str,
    abs_books: list[AbsBook],
    prefer_abs: bool = False,
    hc_client=None,
    existing_hc_ids: set[int] | None = None,
) -> bool:
    """Sync book data from ABS (ID, cover, and HC ID if missing).
    
    Matches by file path from book.files.
    If hc_client is provided and book lacks hardcover_id, will search Hardcover.
    existing_hc_ids is a set of HC IDs already assigned to avoid UNIQUE conflicts.
    Returns True if any data was updated.
    """
    if not book.files:
        return False
    
    # Get file paths from book - extract folder paths (ABS stores folder, not file)
    book_paths = set()
    for bf in book.files:
        if bf.file_path:
            # Booksarr stores: Author/Series/Book/filename.epub
            # ABS stores: Author/Series/Book (folder only)
            path_parts = bf.file_path.split("/")
            
            # Remove filename to get folder path
            if len(path_parts) > 1:
                folder_path = "/".join(path_parts[:-1]).lower()
                book_paths.add(folder_path)
            
            # Also try various subpaths for flexibility
            for i in range(len(path_parts) - 1):  # -1 to exclude filename
                subpath = "/".join(path_parts[i:-1]).lower()
                if subpath:
                    book_paths.add(subpath)
    
    if not book_paths:
        return False
    
    # Find matching ABS book by path
    matching_abs_book = None
    for abs_book in abs_books:
        abs_rel_path = abs_book.rel_path.lower().strip("/")
        
        for book_path in book_paths:
            book_path_clean = book_path.strip("/")
            
            # Exact match
            if abs_rel_path == book_path_clean:
                matching_abs_book = abs_book
                break
            
            # ABS path ends with book path (Booksarr might have shorter path)
            if abs_rel_path.endswith("/" + book_path_clean):
                matching_abs_book = abs_book
                break
            
            # Book path ends with ABS path (Booksarr might have longer path)
            if book_path_clean.endswith("/" + abs_rel_path):
                matching_abs_book = abs_book
                break
                
        if matching_abs_book:
            break
    
    if not matching_abs_book:
        return False
    
    updated = False
    
    # Always update ABS book ID if we have a match
    if book.abs_book_id != matching_abs_book.id:
        book.abs_book_id = matching_abs_book.id
        updated = True
    
    # If book lacks Hardcover ID and we have an HC client, try to look it up
    if not book.hardcover_id and hc_client:
        author_name = book.author.name if book.author else None
        try:
            hc_id, contributors = await hc_client.search_book_by_title(
                book.title, author_name
            )
            if hc_id:
                # Store contributors even if we can't set HC ID (useful for co-author info)
                if contributors:
                    book.contributors = json.dumps(contributors)
                    updated = True
                
                # Check if this HC ID is already used by another book
                # to avoid UNIQUE constraint violations
                if existing_hc_ids is not None and hc_id in existing_hc_ids:
                    logger.debug(
                        "HC ID %d already assigned to another book, skipping for: %s",
                        hc_id, book.title
                    )
                else:
                    book.hardcover_id = hc_id
                    if existing_hc_ids is not None:
                        existing_hc_ids.add(hc_id)
                    logger.info(
                        "Found Hardcover ID %d for book: %s (contributors: %s)",
                        hc_id, book.title, contributors
                    )
                    updated = True
        except Exception as e:
            logger.debug("HC lookup failed for %s: %s", book.title, e)
    
    # Sync cover if ABS has one and we don't (or prefer ABS)
    if matching_abs_book.has_cover:
        if not book.cover_image_cached_path or prefer_abs:
            # Use internal URL for cover download (faster)
            internal_url = await get_internal_url(abs_url, abs_api_key)
            internal_url = internal_url.rstrip("/")
            cover_url = f"{internal_url}/api/items/{matching_abs_book.id}/cover"
            
            try:
                cached_path = await cache_book_cover(
                    book.id,
                    cover_url,
                    source="abs",
                    overwrite=prefer_abs,
                    auth_header=f"Bearer {abs_api_key}",
                )
                
                if cached_path:
                    book.cover_image_url = cover_url
                    book.cover_image_cached_path = cached_path
                    logger.info("Synced ABS cover for book: %s", book.title)
                    updated = True
            except Exception as e:
                logger.warning("Failed to cache ABS cover for %s: %s", book.title, e)
    
    if updated:
        logger.debug("Synced book %s from ABS (id=%s)", book.title, matching_abs_book.id)
    
    return updated


async def sync_all_from_abs(db: AsyncSession, lookup_hardcover: bool = True) -> AbsSyncStatus:
    """Sync all data from ABS (authors and books: IDs, ASINs, images/covers).
    
    If lookup_hardcover is True, will also search Hardcover for books
    that don't have a hardcover_id.
    """
    global _sync_status
    
    # Start API usage batching to avoid concurrent SQLite writes
    batch_token = begin_api_usage_batch()
    
    try:
        return await _sync_all_from_abs_impl(db, lookup_hardcover)
    finally:
        # Flush batched API usage counts at the end
        try:
            await flush_api_usage_batch(db)
            await db.commit()
        except Exception as e:
            logger.warning("Failed to flush API usage batch: %s", e)
        clear_api_usage_batch(batch_token)


async def _sync_all_from_abs_impl(db: AsyncSession, lookup_hardcover: bool) -> AbsSyncStatus:
    """Internal implementation of sync_all_from_abs."""
    global _sync_status
    
    # Get ABS settings
    url, api_key, library_id, enabled, prefer_abs = await get_abs_settings(db)
    
    if not enabled:
        _sync_status = AbsSyncStatus(status="failed", message="ABS integration is not enabled")
        return _sync_status
    
    if not url or not api_key or not library_id:
        _sync_status = AbsSyncStatus(status="failed", message="ABS not fully configured")
        return _sync_status
    
    _sync_status = AbsSyncStatus(status="syncing", message="Fetching data from Audiobookshelf...")
    
    # Get Hardcover client if we want to lookup missing HC IDs
    hc_client = None
    if lookup_hardcover:
        from backend.app.services.hardcover import HardcoverClient
        # Get Hardcover API key from settings
        hc_api_key_result = await db.execute(
            select(Setting).where(Setting.key == "hardcover_api_key")
        )
        hc_api_key_setting = hc_api_key_result.scalar_one_or_none()
        if hc_api_key_setting and hc_api_key_setting.value:
            hc_client = HardcoverClient(hc_api_key_setting.value)
            logger.info("Hardcover client initialized for HC ID lookup")
    
    try:
        # Fetch ABS authors and books
        abs_authors = await fetch_abs_authors(url, api_key, library_id)
        abs_books = await fetch_abs_books(url, api_key, library_id)
        
        logger.info("Fetched %d authors and %d books from ABS", len(abs_authors), len(abs_books))
        
        # Get all authors and books from database
        author_result = await db.execute(select(Author))
        authors = list(author_result.scalars().all())
        
        book_result = await db.execute(select(Book))
        books = list(book_result.scalars().all())
        
        _sync_status.total_authors = len(authors)
        _sync_status.total_books = len(books)
        _sync_status.message = f"Processing {len(authors)} authors and {len(books)} books..."
        
        # Sync authors
        for author in authors:
            _sync_status.authors_processed += 1
            
            try:
                updated = await sync_author_from_abs(
                    author, url, api_key, abs_authors, prefer_abs
                )
                
                if updated:
                    _sync_status.authors_updated += 1
                else:
                    _sync_status.authors_skipped += 1
                    
            except Exception as e:
                logger.warning("Error syncing author %s: %s", author.name, e)
                _sync_status.authors_failed += 1
        
        # Sync books (only lookup HC for books without hardcover_id)
        books_needing_hc = [b for b in books if not b.hardcover_id]
        logger.info(
            "Books needing HC lookup: %d of %d total",
            len(books_needing_hc), len(books)
        )
        
        # Build set of existing HC IDs to avoid UNIQUE constraint violations
        existing_hc_ids: set[int] = {b.hardcover_id for b in books if b.hardcover_id}
        
        for book in books:
            _sync_status.books_processed += 1
            book_id = book.id  # Store ID before any operations
            book_title = book.title  # Store title before any operations
            
            try:
                # Only pass hc_client for books that need HC lookup
                client_for_book = hc_client if not book.hardcover_id else None
                
                updated = await sync_book_from_abs(
                    book, url, api_key, abs_books, prefer_abs, client_for_book, existing_hc_ids
                )
                
                if updated:
                    _sync_status.books_updated += 1
                else:
                    _sync_status.books_skipped += 1
                    
            except Exception as e:
                logger.warning("Error syncing book id=%s title=%s: %s", book_id, book_title, e)
                _sync_status.books_failed += 1
        
        await db.commit()
        
        _sync_status.status = "completed"
        _sync_status.message = (
            f"Synced {_sync_status.authors_updated} authors, "
            f"{_sync_status.books_updated} books"
        )
        logger.info(
            "ABS sync complete: authors=%d updated/%d skipped/%d failed, "
            "books=%d updated/%d skipped/%d failed",
            _sync_status.authors_updated, _sync_status.authors_skipped, _sync_status.authors_failed,
            _sync_status.books_updated, _sync_status.books_skipped, _sync_status.books_failed,
        )
        
    except Exception as e:
        logger.exception("ABS sync failed")
        _sync_status = AbsSyncStatus(status="failed", message=str(e))
    finally:
        if hc_client:
            await hc_client.close()
    
    return _sync_status


# Keep old function name as alias for backward compatibility
async def sync_all_author_images(db: AsyncSession) -> AbsSyncStatus:
    """Deprecated: Use sync_all_from_abs instead."""
    return await sync_all_from_abs(db)



async def lookup_abs_item_by_path(
    file_path: str,
    abs_url: str,
    abs_api_key: str,
    abs_library_id: str,
) -> dict | None:
    """Look up an ABS library item by matching file path.
    
    Returns the ABS item dict if found, None otherwise.
    """
    # Use internal URL for API call
    internal_url = await get_internal_url(abs_url, abs_api_key)
    internal_url = internal_url.rstrip("/")
    headers = {"Authorization": f"Bearer {abs_api_key}"}
    
    # Normalize the file path for comparison
    # Booksarr stores paths like "Author Name/Series/Book Title/file.epub"
    # ABS stores relPath like "Author Name/Series/Book Title"
    
    # Extract the directory part (without the filename)
    if "/" in file_path:
        search_path = "/".join(file_path.split("/")[:-1])  # Remove filename
    else:
        search_path = file_path
    
    # Normalize for comparison
    search_path_lower = search_path.lower().strip("/")
    
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            # Fetch all items and search by path
            # Note: ABS doesn't have a direct path search, so we fetch and filter
            resp = await client.get(
                f"{internal_url}/api/libraries/{abs_library_id}/items",
                headers=headers,
                params={"limit": 0}  # Get all items
            )
            
            if resp.status_code != 200:
                logger.warning("Failed to fetch ABS items: %d", resp.status_code)
                return None
            
            data = resp.json()
            
            for item in data.get("results", []):
                rel_path = item.get("relPath", "")
                if rel_path.lower().strip("/") == search_path_lower:
                    return item
            
            # Try partial match (in case of minor path differences)
            for item in data.get("results", []):
                rel_path = item.get("relPath", "").lower()
                # Check if the search path ends with the ABS relPath or vice versa
                if search_path_lower.endswith(rel_path) or rel_path.endswith(search_path_lower):
                    return item
            
            return None
            
    except Exception as e:
        logger.warning("Error looking up ABS item by path: %s", e)
        return None


async def get_abs_item_url(
    file_path: str,
    configured_abs_url: str,
    abs_api_key: str,
    abs_library_id: str,
) -> str | None:
    """Get the ABS web URL for a book given its file path.
    
    Returns the URL to open in browser (using configured external URL),
    or None if not found.
    """
    item = await lookup_abs_item_by_path(file_path, configured_abs_url, abs_api_key, abs_library_id)
    
    if not item:
        return None
    
    # Use the configured URL (external) for browser links
    external_url = configured_abs_url.rstrip("/")
    item_id = item.get("id")
    
    if not item_id:
        return None
    
    return f"{external_url}/item/{item_id}"
