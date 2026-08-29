"""Audiobookshelf integration endpoints."""

import asyncio
import logging
from typing import Any

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.config import ABS_URL, ABS_API_KEY, ABS_LIBRARY_ID
from backend.app.database import get_db
from backend.app.models import Setting
from backend.app.services.abs_sync import (
    sync_all_from_abs,
    get_sync_status,
    AbsSyncStatus,
)

logger = logging.getLogger("booksarr.abs")

router = APIRouter(prefix="/api/abs", tags=["audiobookshelf"])


class AbsLibrary(BaseModel):
    id: str
    name: str
    mediaType: str
    folders: list[dict[str, Any]] = []


class TestConnectionRequest(BaseModel):
    url: str | None = None
    api_key: str | None = None


class TestConnectionResponse(BaseModel):
    success: bool
    message: str
    server_version: str | None = None
    libraries: list[AbsLibrary] = []


async def get_abs_settings(db: AsyncSession) -> tuple[str, str, str]:
    """Get ABS settings from DB or environment."""
    result = await db.execute(select(Setting))
    settings = {s.key: s.value for s in result.scalars().all()}
    
    url = settings.get("abs_url", "") or ABS_URL
    api_key = settings.get("abs_api_key", "") or ABS_API_KEY
    library_id = settings.get("abs_library_id", "") or ABS_LIBRARY_ID
    
    return url, api_key, library_id


@router.post("/test-connection", response_model=TestConnectionResponse)
async def test_connection(
    body: TestConnectionRequest,
    db: AsyncSession = Depends(get_db),
):
    """Test connection to Audiobookshelf and return available libraries."""
    # Use provided values or fall back to saved settings
    if body.url and body.api_key:
        url = body.url.rstrip("/")
        api_key = body.api_key
    else:
        url, api_key, _ = await get_abs_settings(db)
        url = url.rstrip("/") if url else ""
    
    if not url:
        return TestConnectionResponse(
            success=False,
            message="No ABS URL configured",
        )
    
    if not api_key:
        return TestConnectionResponse(
            success=False,
            message="No ABS API key configured",
        )
    
    headers = {"Authorization": f"Bearer {api_key}"}
    
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            # Test auth by getting current user info
            auth_resp = await client.get(f"{url}/api/me", headers=headers)
            
            if auth_resp.status_code == 401:
                return TestConnectionResponse(
                    success=False,
                    message="Authentication failed - invalid API key",
                )
            
            if auth_resp.status_code != 200:
                return TestConnectionResponse(
                    success=False,
                    message=f"Connection failed with status {auth_resp.status_code}",
                )
            
            # Get server settings for version info
            server_version = "unknown"
            try:
                status_resp = await client.get(f"{url}/api/status", headers=headers)
                if status_resp.status_code == 200:
                    status_data = status_resp.json()
                    server_version = status_data.get("serverVersion", "unknown")
            except Exception:
                pass  # Version is optional
            
            # Get libraries
            libs_resp = await client.get(f"{url}/api/libraries", headers=headers)
            
            if libs_resp.status_code != 200:
                return TestConnectionResponse(
                    success=True,
                    message=f"Connected but could not fetch libraries (status {libs_resp.status_code})",
                    server_version=server_version,
                )
            
            libs_data = libs_resp.json()
            libraries = []
            
            for lib in libs_data.get("libraries", []):
                # Only include book libraries (not podcast)
                if lib.get("mediaType") == "book":
                    libraries.append(AbsLibrary(
                        id=lib["id"],
                        name=lib["name"],
                        mediaType=lib["mediaType"],
                        folders=lib.get("folders", []),
                    ))
            
            return TestConnectionResponse(
                success=True,
                message=f"Connected to Audiobookshelf{' v' + server_version if server_version and server_version != 'unknown' else ''}",
                server_version=server_version,
                libraries=libraries,
            )
    
    except httpx.ConnectError as e:
        logger.warning("ABS connection error: %s", e)
        return TestConnectionResponse(
            success=False,
            message=f"Could not connect to {url} - connection refused",
        )
    except httpx.TimeoutException:
        return TestConnectionResponse(
            success=False,
            message=f"Connection to {url} timed out",
        )
    except Exception as e:
        logger.exception("ABS test connection error")
        return TestConnectionResponse(
            success=False,
            message=f"Error: {str(e)}",
        )


@router.get("/libraries", response_model=list[AbsLibrary])
async def get_libraries(db: AsyncSession = Depends(get_db)):
    """Get available ABS libraries using saved credentials."""
    url, api_key, _ = await get_abs_settings(db)
    
    if not url or not api_key:
        raise HTTPException(status_code=400, detail="ABS not configured")
    
    url = url.rstrip("/")
    headers = {"Authorization": f"Bearer {api_key}"}
    
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{url}/api/libraries", headers=headers)
            
            if resp.status_code != 200:
                raise HTTPException(status_code=502, detail="Failed to fetch libraries from ABS")
            
            data = resp.json()
            libraries = []
            
            for lib in data.get("libraries", []):
                if lib.get("mediaType") == "book":
                    libraries.append(AbsLibrary(
                        id=lib["id"],
                        name=lib["name"],
                        mediaType=lib["mediaType"],
                        folders=lib.get("folders", []),
                    ))
            
            return libraries
    
    except httpx.RequestError as e:
        logger.warning("ABS libraries fetch error: %s", e)
        raise HTTPException(status_code=502, detail=str(e))


class SyncStatusResponse(BaseModel):
    status: str
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


# Background task reference
_sync_task: asyncio.Task | None = None


@router.get("/sync-status", response_model=SyncStatusResponse)
async def get_abs_sync_status():
    """Get the current status of ABS sync."""
    status = get_sync_status()
    return SyncStatusResponse(
        status=status.status,
        total_authors=status.total_authors,
        total_books=status.total_books,
        authors_processed=status.authors_processed,
        authors_updated=status.authors_updated,
        authors_skipped=status.authors_skipped,
        authors_failed=status.authors_failed,
        books_processed=status.books_processed,
        books_updated=status.books_updated,
        books_skipped=status.books_skipped,
        books_failed=status.books_failed,
        message=status.message,
    )


async def _run_sync_in_background(db_url: str):
    """Run sync in background with its own database session."""
    from backend.app.database import async_session
    
    async with async_session() as db:
        try:
            await sync_all_from_abs(db)
        except Exception as e:
            logger.exception("Background sync failed: %s", e)


@router.post("/sync", response_model=SyncStatusResponse)
async def start_abs_sync(background_tasks: BackgroundTasks, db: AsyncSession = Depends(get_db)):
    """Start syncing data from Audiobookshelf (authors and books: IDs, ASINs, images, covers).
    
    Returns immediately - sync runs in background. Poll /sync-status for progress.
    """
    # Check if already syncing
    current_status = get_sync_status()
    if current_status.status == "syncing":
        return SyncStatusResponse(
            status="syncing",
            total_authors=current_status.total_authors,
            total_books=current_status.total_books,
            authors_processed=current_status.authors_processed,
            authors_updated=current_status.authors_updated,
            authors_skipped=current_status.authors_skipped,
            authors_failed=current_status.authors_failed,
            books_processed=current_status.books_processed,
            books_updated=current_status.books_updated,
            books_skipped=current_status.books_skipped,
            books_failed=current_status.books_failed,
            message="Sync already in progress",
        )
    
    # Start sync in background
    background_tasks.add_task(_run_sync_in_background, str(db.get_bind().url) if db.get_bind() else "")
    
    # Return immediately with "syncing" status
    return SyncStatusResponse(
        status="syncing",
        total_authors=0,
        total_books=0,
        authors_processed=0,
        authors_updated=0,
        authors_skipped=0,
        authors_failed=0,
        books_processed=0,
        books_updated=0,
        books_skipped=0,
        books_failed=0,
        message="Sync started",
    )


# Keep old endpoint for backward compatibility
@router.post("/sync-author-images", response_model=SyncStatusResponse)
async def start_author_image_sync(db: AsyncSession = Depends(get_db)):
    """Deprecated: Use /sync instead. Redirects to full sync."""
    return await start_abs_sync(db)



class LookupBookRequest(BaseModel):
    file_path: str


class LookupBookResponse(BaseModel):
    found: bool
    abs_url: str | None = None
    abs_book_id: str | None = None
    abs_title: str | None = None


@router.post("/lookup-book", response_model=LookupBookResponse)
async def lookup_book_in_abs(
    body: LookupBookRequest,
    db: AsyncSession = Depends(get_db),
):
    """Look up a book in ABS by file path and return URL to open."""
    from backend.app.services.abs_sync import get_abs_item_url, lookup_abs_item_by_path, get_abs_settings as get_abs_settings_sync
    
    url, api_key, library_id, enabled, _ = await get_abs_settings_sync(db)
    
    if not enabled or not url or not api_key or not library_id:
        return LookupBookResponse(found=False)
    
    item = await lookup_abs_item_by_path(body.file_path, url, api_key, library_id)
    
    if not item:
        return LookupBookResponse(found=False)
    
    external_url = url.rstrip("/")
    item_id = item.get("id")
    title = item.get("media", {}).get("metadata", {}).get("title")
    
    return LookupBookResponse(
        found=True,
        abs_url=f"{external_url}/item/{item_id}",
        abs_book_id=item_id,
        abs_title=title,
    )


class SearchBookRequest(BaseModel):
    title: str
    author_name: str | None = None


class SearchBookResponse(BaseModel):
    found: bool
    abs_url: str | None = None
    abs_book_id: str | None = None
    abs_title: str | None = None


@router.post("/search-book", response_model=SearchBookResponse)
async def search_book_in_abs(
    body: SearchBookRequest,
    db: AsyncSession = Depends(get_db),
):
    """Search for a book in ABS by title and author name."""
    from backend.app.services.abs_sync import get_abs_settings as get_abs_settings_sync, get_internal_url, get_external_url
    import httpx
    import re
    
    url, api_key, library_id, enabled, _ = await get_abs_settings_sync(db)
    
    if not enabled or not url or not api_key or not library_id:
        return SearchBookResponse(found=False)
    
    # Use internal URL for API call, external for browser links
    internal_url = await get_internal_url(url, api_key)
    internal_url = internal_url.rstrip("/")
    external_url = get_external_url(url)
    headers = {"Authorization": f"Bearer {api_key}"}
    
    # Build search query - just use title for broader search
    search_query = body.title
    
    def normalize_title(title: str) -> str:
        """Normalize title for comparison - strip year, punctuation, lowercase."""
        # Remove year suffixes like (2022), [2022]
        title = re.sub(r'\s*[\(\[]\d{4}[\)\]]\s*$', '', title)
        # Normalize separators (colon, dash, etc. to space)
        title = re.sub(r'[:\-–—]', ' ', title)
        # Remove extra whitespace
        title = ' '.join(title.lower().split())
        return title
    
    def titles_similar(title1: str, title2: str) -> bool:
        """Check if titles are similar enough to be a match."""
        norm1 = normalize_title(title1)
        norm2 = normalize_title(title2)
        
        # Exact match after normalization
        if norm1 == norm2:
            return True
        
        # One contains the other
        if norm1 in norm2 or norm2 in norm1:
            return True
        
        # Check word overlap - if most words from search title are in result
        words1 = set(norm1.split())
        words2 = set(norm2.split())
        if len(words1) >= 2:
            overlap = len(words1 & words2)
            if overlap >= len(words1) * 0.7:  # 70% of words match
                return True
        
        return False
    
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(
                f"{internal_url}/api/libraries/{library_id}/search",
                headers=headers,
                params={"q": search_query, "limit": 10}
            )
            
            if resp.status_code != 200:
                return SearchBookResponse(found=False)
            
            data = resp.json()
            
            # Search results are in "book" array
            books = data.get("book", [])
            
            if not books:
                return SearchBookResponse(found=False)
            
            # Find best match using flexible title comparison
            best_match = None
            
            for book_result in books:
                item = book_result.get("libraryItem", {})
                metadata = item.get("media", {}).get("metadata", {})
                result_title = metadata.get("title", "")
                
                # Check for title similarity
                if titles_similar(body.title, result_title):
                    # If author specified, verify it matches too
                    if body.author_name:
                        result_author = metadata.get("authorName", "").lower()
                        if body.author_name.lower() in result_author or result_author in body.author_name.lower():
                            best_match = item
                            break
                    else:
                        best_match = item
                        break
            
            # Fall back to first result if no good match but we got results
            # (ABS search is already fuzzy, first result is often correct)
            if not best_match and books:
                best_match = books[0].get("libraryItem", {})
            
            if not best_match:
                return SearchBookResponse(found=False)
            
            item_id = best_match.get("id")
            title = best_match.get("media", {}).get("metadata", {}).get("title")
            
            return SearchBookResponse(
                found=True,
                abs_url=f"{external_url}/item/{item_id}",
                abs_book_id=item_id,
                abs_title=title,
            )
            
    except Exception:
        return SearchBookResponse(found=False)
