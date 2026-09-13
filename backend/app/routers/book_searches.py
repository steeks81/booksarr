"""
Book Search Queue API endpoints.

Provides endpoints for queuing and monitoring release searches.
Enables cross-session/cross-tab visibility of release search state.
"""

import logging

from fastapi import APIRouter, Query
from pydantic import BaseModel

from backend.app.services.book_searches import (
    BookInfo,
    queue_book_search,
    get_all_searches,
    get_searches_by_keys,
    remove_search,
    clear_completed_searches,
    retry_book_search,
    entry_to_dict,
)

logger = logging.getLogger("booksarr.book_searches")

router = APIRouter(prefix="/api", tags=["book-searches"])


# --- Request/Response Models ---

class BookSearchRequest(BaseModel):
    """Request body for queuing a book search."""
    provider: str
    book_id: str
    title: str
    author: str | None = None
    cover_url: str | None = None
    year: int | None = None
    description: str | None = None
    series_name: str | None = None
    series_position: float | None = None


class BookSearchResponse(BaseModel):
    """Response from POST /book-search."""
    success: bool
    search_key: str | None = None
    error: str | None = None  # "already_queued" or error message


class BookSearchesResponse(BaseModel):
    """Response from GET /book-searches."""
    searches: list[dict]


class RemoveSearchResponse(BaseModel):
    """Response from DELETE /book-searches/{search_key}."""
    success: bool


class ClearSearchesResponse(BaseModel):
    """Response from POST /book-searches/clear."""
    removed: int


# --- Endpoints ---

@router.post("/book-search", response_model=BookSearchResponse)
async def create_book_search(body: BookSearchRequest):
    """
    Queue a book for release search.
    
    Returns immediately with a search_key. The actual SM /api/releases
    call happens in the background. Poll GET /book-searches to see status.
    
    If the same book (provider:book_id) is already queued or fetching,
    returns the existing search_key (deduplication).
    """
    logger.info("Book search request: provider=%s book_id=%s title=%r", 
                body.provider, body.book_id, body.title)
    
    book_info = BookInfo(
        provider=body.provider,
        book_id=body.book_id,
        title=body.title,
        author=body.author,
        cover_url=body.cover_url,
        year=body.year,
        description=body.description,
        series_name=body.series_name,
        series_position=body.series_position,
    )
    
    search_key, is_new = await queue_book_search(book_info)
    
    if is_new:
        return BookSearchResponse(success=True, search_key=search_key)
    else:
        return BookSearchResponse(success=False, search_key=search_key, error="already_queued")


@router.get("/book-searches", response_model=BookSearchesResponse)
async def get_book_searches(keys: str | None = Query(None, description="Comma-separated search keys to filter by")):
    """
    Get all book searches or filter by specific keys.
    
    Without keys: Returns all searches (for ActivityPage dashboard).
    With keys: Returns only specified searches (O(1) lookup per key).
    
    Results are ordered by queued_at (newest first).
    """
    if keys:
        key_list = [k.strip() for k in keys.split(",") if k.strip()]
        entries = get_searches_by_keys(key_list)
    else:
        entries = get_all_searches()
    
    return BookSearchesResponse(
        searches=[entry_to_dict(e) for e in entries]
    )


@router.delete("/book-searches/{search_key}", response_model=RemoveSearchResponse)
async def delete_book_search(search_key: str):
    """
    Remove a specific search from the queue.
    
    Use this to dismiss completed/errored searches from the UI.
    """
    logger.info("Book search delete: %s", search_key)
    success = remove_search(search_key)
    return RemoveSearchResponse(success=success)


@router.post("/book-searches/{search_key}/retry", response_model=RemoveSearchResponse)
async def retry_search(search_key: str):
    """
    Retry a book search to re-fetch releases.
    
    Only works for complete/error status. Resets the entry and re-queues it.
    """
    logger.info("Book search retry: %s", search_key)
    success = await retry_book_search(search_key)
    return RemoveSearchResponse(success=success)


@router.post("/book-searches/clear", response_model=ClearSearchesResponse)
async def clear_book_searches():
    """
    Clear all completed and errored searches.
    
    Keeps pending and fetching searches intact.
    """
    logger.info("Book searches clear request")
    removed = clear_completed_searches()
    return ClearSearchesResponse(removed=removed)
