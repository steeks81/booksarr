"""Audiobookshelf integration service for syncing metadata."""

import logging
from dataclasses import dataclass

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.config import ABS_URL, ABS_API_KEY, ABS_LIBRARY_ID, CONFIG_DIR
from backend.app.models import Author, Setting
from backend.app.services.image_cache import cache_author_image

logger = logging.getLogger("booksarr.abs_sync")

# Internal Docker hostnames to try for faster API calls
_INTERNAL_ABS_URLS = [
    "http://audiobookshelf:80",
    "http://audiobookshelf:13378",
]

# Cached working internal URL (None = not tested, "" = no internal works)
_cached_internal_url: str | None = None


async def get_best_abs_url(configured_url: str, api_key: str) -> str:
    """Try internal Docker URLs first, fall back to configured URL.
    
    This allows users to configure the external URL for browser links
    while the backend uses faster internal Docker networking when available.
    """
    global _cached_internal_url
    
    # Return cached result if we've already tested
    if _cached_internal_url is not None:
        if _cached_internal_url:
            return _cached_internal_url
        return configured_url
    
    headers = {"Authorization": f"Bearer {api_key}"}
    
    # Try internal URLs first
    for internal_url in _INTERNAL_ABS_URLS:
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                resp = await client.get(f"{internal_url}/ping", headers=headers)
                if resp.status_code == 200:
                    logger.info("Using internal ABS URL: %s", internal_url)
                    _cached_internal_url = internal_url
                    return internal_url
        except Exception:
            continue
    
    # No internal URL works, use configured
    logger.info("Using configured ABS URL: %s", configured_url)
    _cached_internal_url = ""  # Mark as tested, no internal works
    return configured_url


@dataclass
class AbsAuthor:
    id: str
    name: str
    asin: str | None
    description: str | None
    image_path: str | None


@dataclass
class AbsSyncStatus:
    status: str  # idle, syncing, completed, failed
    total_authors: int = 0
    processed: int = 0
    updated: int = 0
    skipped: int = 0
    failed: int = 0
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
    # Try internal URL first for speed
    url = await get_best_abs_url(url, api_key)
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


def normalize_author_name(name: str) -> str:
    """Normalize author name for matching."""
    # Remove common suffixes, lowercase, strip whitespace
    name = name.lower().strip()
    # Remove Jr., Sr., III, etc.
    for suffix in [" jr.", " sr.", " jr", " sr", " iii", " ii", " iv"]:
        if name.endswith(suffix):
            name = name[:-len(suffix)]
    return name


async def sync_author_image_from_abs(
    author: Author,
    abs_url: str,
    abs_api_key: str,
    abs_authors: list[AbsAuthor],
    prefer_abs: bool = False,
) -> bool:
    """Sync author image from ABS if available.
    
    Returns True if image was updated.
    """
    # Skip if author already has an image and we're not preferring ABS
    if author.image_cached_path and not prefer_abs:
        return False
    
    # Find matching ABS author by name
    normalized_name = normalize_author_name(author.name)
    matching_abs_author = None
    
    for abs_author in abs_authors:
        if normalize_author_name(abs_author.name) == normalized_name:
            matching_abs_author = abs_author
            break
    
    if not matching_abs_author or not matching_abs_author.image_path:
        return False
    
    # Use internal URL for image download (faster)
    internal_url = await get_best_abs_url(abs_url, abs_api_key)
    internal_url = internal_url.rstrip("/")
    image_url = f"{internal_url}/api/authors/{matching_abs_author.id}/image"
    
    # Download and cache the image
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
            return True
    except Exception as e:
        logger.warning("Failed to cache ABS author image for %s: %s", author.name, e)
    
    return False


async def sync_all_author_images(db: AsyncSession) -> AbsSyncStatus:
    """Sync author images from ABS for all authors missing images."""
    global _sync_status
    
    # Get ABS settings
    url, api_key, library_id, enabled, prefer_abs = await get_abs_settings(db)
    
    if not enabled:
        _sync_status = AbsSyncStatus(status="failed", message="ABS integration is not enabled")
        return _sync_status
    
    if not url or not api_key or not library_id:
        _sync_status = AbsSyncStatus(status="failed", message="ABS not fully configured")
        return _sync_status
    
    _sync_status = AbsSyncStatus(status="syncing", message="Fetching authors from ABS...")
    
    try:
        # Fetch ABS authors
        abs_authors = await fetch_abs_authors(url, api_key, library_id)
        
        if not abs_authors:
            _sync_status = AbsSyncStatus(status="failed", message="No authors found in ABS")
            return _sync_status
        
        logger.info("Fetched %d authors from ABS", len(abs_authors))
        
        # Get all authors from database
        result = await db.execute(select(Author))
        authors = list(result.scalars().all())
        
        _sync_status.total_authors = len(authors)
        _sync_status.message = f"Processing {len(authors)} authors..."
        
        for author in authors:
            _sync_status.processed += 1
            
            # Skip if already has image and not preferring ABS
            if author.image_cached_path and not prefer_abs:
                _sync_status.skipped += 1
                continue
            
            try:
                updated = await sync_author_image_from_abs(
                    author, url, api_key, abs_authors, prefer_abs
                )
                
                if updated:
                    _sync_status.updated += 1
                else:
                    _sync_status.skipped += 1
                    
            except Exception as e:
                logger.warning("Error syncing author %s: %s", author.name, e)
                _sync_status.failed += 1
        
        await db.commit()
        
        _sync_status.status = "completed"
        _sync_status.message = f"Synced {_sync_status.updated} author images"
        logger.info(
            "ABS author image sync complete: %d updated, %d skipped, %d failed",
            _sync_status.updated, _sync_status.skipped, _sync_status.failed
        )
        
    except Exception as e:
        logger.exception("ABS author image sync failed")
        _sync_status = AbsSyncStatus(status="failed", message=str(e))
    
    return _sync_status



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
    internal_url = await get_best_abs_url(abs_url, abs_api_key)
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
