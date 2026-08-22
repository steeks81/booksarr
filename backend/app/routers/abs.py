"""Audiobookshelf integration endpoints."""

import asyncio
import logging
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.config import ABS_URL, ABS_API_KEY, ABS_LIBRARY_ID
from backend.app.database import get_db
from backend.app.models import Setting
from backend.app.services.abs_sync import (
    sync_all_author_images,
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
                message=f"Connected to Audiobookshelf v{server_version}",
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
    processed: int = 0
    updated: int = 0
    skipped: int = 0
    failed: int = 0
    message: str = ""


# Background task reference
_sync_task: asyncio.Task | None = None


@router.get("/sync-status", response_model=SyncStatusResponse)
async def get_author_sync_status():
    """Get the current status of author image sync."""
    status = get_sync_status()
    return SyncStatusResponse(
        status=status.status,
        total_authors=status.total_authors,
        processed=status.processed,
        updated=status.updated,
        skipped=status.skipped,
        failed=status.failed,
        message=status.message,
    )


@router.post("/sync-author-images", response_model=SyncStatusResponse)
async def start_author_image_sync(db: AsyncSession = Depends(get_db)):
    """Start syncing author images from Audiobookshelf."""
    global _sync_task
    
    # Check if already syncing
    current_status = get_sync_status()
    if current_status.status == "syncing":
        return SyncStatusResponse(
            status="syncing",
            total_authors=current_status.total_authors,
            processed=current_status.processed,
            updated=current_status.updated,
            skipped=current_status.skipped,
            failed=current_status.failed,
            message="Sync already in progress",
        )
    
    # Run sync (this is a relatively quick operation so run synchronously)
    result = await sync_all_author_images(db)
    
    return SyncStatusResponse(
        status=result.status,
        total_authors=result.total_authors,
        processed=result.processed,
        updated=result.updated,
        skipped=result.skipped,
        failed=result.failed,
        message=result.message,
    )



class LookupBookRequest(BaseModel):
    file_path: str


class LookupBookResponse(BaseModel):
    found: bool
    abs_url: str | None = None
    abs_item_id: str | None = None
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
        abs_item_id=item_id,
        abs_title=title,
    )
