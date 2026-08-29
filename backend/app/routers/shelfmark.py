"""
Shelfmark integration API endpoints.

Provides search functionality proxied through Booksarr.
Downloads happen directly in Shelfmark (handles Cloudflare there).
"""

import json
import logging
from typing import Literal

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from backend.app.services.shelfmark import (
    search as shelfmark_search,
    test_connection as shelfmark_test_connection,
    get_shelfmark_url,
    get_releases as shelfmark_get_releases,
    get_book as shelfmark_get_book,
    initiate_download as shelfmark_initiate_download,
    get_download_status as shelfmark_get_status,
    cancel_download as shelfmark_cancel_download,
    retry_download as shelfmark_retry_download,
    dismiss_many_downloads as shelfmark_dismiss_many,
    enrich_series_stream as shelfmark_enrich_series,
    get_series_from_cache,
    set_series_in_cache,
    get_series_cache_stats,
    clear_series_cache,
)

logger = logging.getLogger("booksarr.shelfmark")

router = APIRouter(prefix="/api/shelfmark", tags=["shelfmark"])


class ShelfmarkSearchRequest(BaseModel):
    """Request body for Shelfmark search."""
    query: str = ""
    media_type: Literal["ebook", "audiobook"] = "ebook"
    series: str | None = None
    author: str | None = None
    title: str | None = None


class ShelfmarkDisplayField(BaseModel):
    """A display field (rating, readers, etc.)."""
    label: str
    value: str
    icon: str | None = None


class ShelfmarkSearchResultItem(BaseModel):
    """A single search result from Shelfmark."""
    id: str
    title: str
    author: str | None = None
    format: str | None = None
    size: str | None = None
    source: str | None = None  # Display name (e.g., "Google Books", "Hardcover")
    provider: str | None = None  # Provider code (e.g., "googlebooks", "hardcover")
    download_url: str | None = None
    cover_url: str | None = None
    # Additional metadata fields
    year: int | None = None
    description: str | None = None
    source_url: str | None = None
    isbn: str | None = None
    # Series info
    series_name: str | None = None
    series_position: float | None = None
    series_count: int | None = None
    # Display fields
    display_fields: list[ShelfmarkDisplayField] | None = None


class ShelfmarkSearchResponse(BaseModel):
    """Response from Shelfmark search endpoint."""
    query: str
    results: list[ShelfmarkSearchResultItem]
    total_results: int
    shelfmark_url: str | None = None
    error: str | None = None


class ShelfmarkConnectionResponse(BaseModel):
    """Response from Shelfmark connection test."""
    connected: bool
    url: str | None = None
    error: str | None = None


class ShelfmarkTestConnectionRequest(BaseModel):
    """Request body for Shelfmark connection test."""
    url: str | None = None
    username: str | None = None
    password: str | None = None


@router.post("/search", response_model=ShelfmarkSearchResponse)
async def search(body: ShelfmarkSearchRequest):
    """
    Search Shelfmark for books.
    
    Proxies the search request through Booksarr's authenticated
    session with the configured Shelfmark instance.
    
    Returns results with shelfmark_url so frontend can construct
    direct links to download in Shelfmark.
    """
    logger.info("Shelfmark search: query=%r media_type=%s series=%r author=%r title=%r", body.query, body.media_type, body.series, body.author, body.title)
    
    # Log the effective search type for debugging
    if body.series:
        logger.info("Search type: SERIES search for %r", body.series)
    elif body.author:
        logger.info("Search type: AUTHOR search for %r", body.author)
    elif body.title:
        logger.info("Search type: TITLE search for %r", body.title)
    elif body.query:
        logger.info("Search type: GENERAL search for %r", body.query)
    
    result = await shelfmark_search(body.query, body.media_type, body.series, body.author, body.title)
    
    return ShelfmarkSearchResponse(
        query=result.query,
        results=[
            ShelfmarkSearchResultItem(
                id=r.id,
                title=r.title,
                author=r.author,
                format=r.format,
                size=r.size,
                source=r.source,
                provider=r.provider,
                download_url=r.download_url,
                cover_url=r.cover_url,
                year=r.year,
                description=r.description,
                source_url=r.source_url,
                isbn=r.isbn,
                series_name=r.series_name,
                series_position=r.series_position,
                series_count=r.series_count,
                display_fields=[
                    ShelfmarkDisplayField(label=f["label"], value=f["value"], icon=f.get("icon"))
                    for f in (r.display_fields or [])
                ] if r.display_fields else None,
            )
            for r in result.results
        ],
        total_results=result.total_results,
        shelfmark_url=result.shelfmark_url,
        error=result.error,
    )


class ShelfmarkSeriesEnrichRequest(BaseModel):
    """Request body for series enrichment."""
    books: list[dict]  # List of {"provider": "...", "book_id": "..."}


@router.post("/search/enrich-series")
async def enrich_series(body: ShelfmarkSeriesEnrichRequest):
    """
    Stream series info for a list of books via Server-Sent Events.
    
    Returns SSE stream with events:
    - progress: {"type": "progress", "current": 5, "total": 20}
    - series: {"type": "series", "book_id": "...", "series_name": "...", ...}
    - done: {"type": "done"}
    """
    async def event_generator():
        async for event in shelfmark_enrich_series(body.books):
            yield f"data: {json.dumps(event)}\n\n"
    
    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )


@router.post("/test", response_model=ShelfmarkConnectionResponse)
async def test_connection(body: ShelfmarkTestConnectionRequest):
    """
    Test the connection to Shelfmark.
    
    Verifies that Booksarr can authenticate with the configured
    Shelfmark instance. Optionally accepts URL/username/password
    to test before saving.
    """
    result = await shelfmark_test_connection(
        url=body.url,
        username=body.username,
        password=body.password,
    )
    
    return ShelfmarkConnectionResponse(
        connected=result.get("connected", False),
        url=result.get("url"),
        error=result.get("error"),
    )


@router.get("/url")
async def get_url():
    """
    Get the configured Shelfmark URL.
    
    Used by frontend to construct direct links to Shelfmark.
    """
    url = await get_shelfmark_url()
    return {"url": url}



# --- Releases and Download endpoints ---

class ShelfmarkReleasesRequest(BaseModel):
    """Request body for fetching releases."""
    provider: str
    book_id: str
    # Optional manual query for direct search (bypasses SM's metadata-based search)
    manual_query: str | None = None


class ShelfmarkReleaseItem(BaseModel):
    """A single release/download option."""
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


class ShelfmarkBookInfo(BaseModel):
    """Book metadata from releases response."""
    title: str
    author: str | None = None
    description: str | None = None
    cover_url: str | None = None
    year: int | None = None
    isbn: str | None = None
    source_url: str | None = None
    provider: str | None = None
    provider_id: str | None = None
    # Series info
    series_name: str | None = None
    series_position: float | None = None


class ShelfmarkReleasesResponse(BaseModel):
    """Response from releases endpoint."""
    book: ShelfmarkBookInfo | None = None
    releases: list[ShelfmarkReleaseItem]
    sources: list[str]
    error: str | None = None


class ShelfmarkBookDetailResponse(BaseModel):
    """Full book details from metadata provider."""
    id: str
    title: str
    author: str | None = None
    description: str | None = None
    cover_url: str | None = None
    year: int | None = None
    isbn: str | None = None
    source_url: str | None = None
    provider: str | None = None
    provider_display_name: str | None = None
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
    display_fields: list[ShelfmarkDisplayField] | None = None
    error: str | None = None


class ShelfmarkDownloadRequest(BaseModel):
    """Request body for initiating a download."""
    source: str
    source_id: str
    # Release metadata
    title: str | None = None
    author: str | None = None
    format: str | None = None
    size: str | None = None
    cover_url: str | None = None
    # Book metadata (from the search result / book info)
    book_title: str | None = None
    book_author: str | None = None
    book_year: int | None = None
    book_provider: str | None = None
    book_provider_id: str | None = None
    # Series metadata
    series_name: str | None = None
    series_position: float | None = None


class ShelfmarkDownloadResponse(BaseModel):
    """Response from download endpoint."""
    success: bool
    status: str | None = None
    priority: int | None = None
    error: str | None = None


@router.post("/releases", response_model=ShelfmarkReleasesResponse)
async def get_releases(body: ShelfmarkReleasesRequest):
    """
    Fetch available releases for a book from Shelfmark.
    
    This can take a long time (30-60s+) as Shelfmark waits for
    Cloudflare and aggregates results from multiple sources.
    
    Returns book metadata and list of releases grouped by source.
    """
    logger.info("Shelfmark releases: provider=%s book_id=%s direct=%s", body.provider, body.book_id, bool(body.manual_query))
    
    result = await shelfmark_get_releases(body.provider, body.book_id, body.manual_query)
    
    book_info = None
    if result.book:
        book_info = ShelfmarkBookInfo(
            title=result.book.title,
            author=result.book.author,
            description=result.book.description,
            cover_url=result.book.cover_url,
            year=result.book.year,
            isbn=result.book.isbn,
            source_url=result.book.source_url,
            provider=result.book.provider,
            provider_id=result.book.provider_id,
            series_name=result.book.series_name,
            series_position=result.book.series_position,
        )
    
    return ShelfmarkReleasesResponse(
        book=book_info,
        releases=[
            ShelfmarkReleaseItem(
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
        ],
        sources=result.sources,
        error=result.error,
    )


@router.get("/book/{provider}/{book_id}", response_model=ShelfmarkBookDetailResponse)
async def get_book_detail(provider: str, book_id: str):
    """
    Get full book details from Shelfmark's metadata provider.
    
    Fetches detailed book information including description, series info,
    genres, etc. that are not included in search results.
    
    This is a fast call (~1-2s) unlike releases which can take 30s+.
    """
    logger.info("Shelfmark book detail: provider=%s book_id=%s", provider, book_id)
    
    result = await shelfmark_get_book(provider, book_id)
    
    # Convert display_fields from dict to pydantic model
    display_fields = None
    if result.display_fields:
        display_fields = [
            ShelfmarkDisplayField(
                label=f.get("label", ""),
                value=f.get("value", ""),
                icon=f.get("icon"),
            )
            for f in result.display_fields
        ]
    
    return ShelfmarkBookDetailResponse(
        id=result.id,
        title=result.title,
        author=result.author,
        description=result.description,
        cover_url=result.cover_url,
        year=result.year,
        isbn=result.isbn,
        source_url=result.source_url,
        provider=result.provider,
        provider_display_name=result.provider_display_name,
        series_id=result.series_id,
        series_name=result.series_name,
        series_position=result.series_position,
        series_count=result.series_count,
        genres=result.genres,
        publisher=result.publisher,
        language=result.language,
        display_fields=display_fields,
        error=result.error,
    )


@router.post("/download", response_model=ShelfmarkDownloadResponse)
async def initiate_download(body: ShelfmarkDownloadRequest):
    """
    Initiate a download in Shelfmark.
    
    Queues the selected release for download in the configured
    Shelfmark instance.
    """
    logger.info("Shelfmark download: source=%s source_id=%s title=%s book_author=%s", body.source, body.source_id, body.title, body.book_author)
    
    result = await shelfmark_initiate_download(
        source=body.source,
        source_id=body.source_id,
        title=body.title,
        author=body.author,
        format=body.format,
        size=body.size,
        cover_url=body.cover_url,
        book_title=body.book_title,
        book_author=body.book_author,
        book_year=body.book_year,
        book_provider=body.book_provider,
        book_provider_id=body.book_provider_id,
        series_name=body.series_name,
        series_position=body.series_position,
    )
    
    return ShelfmarkDownloadResponse(
        success=result.success,
        status=result.status,
        priority=result.priority,
        error=result.error,
    )



# --- Download Status endpoint ---

class ShelfmarkDownloadStatusItem(BaseModel):
    """Status of a single download."""
    source_id: str
    title: str
    author: str | None = None
    status: str
    status_message: str | None = None
    progress: float
    source: str
    source_display_name: str | None = None
    format: str | None = None
    size: str | None = None
    cover_url: str | None = None


class ShelfmarkStatusResponse(BaseModel):
    """Response from status endpoint."""
    in_progress: list[ShelfmarkDownloadStatusItem]
    complete: list[ShelfmarkDownloadStatusItem]
    failed: list[ShelfmarkDownloadStatusItem]
    error: str | None = None


def _convert_status_items(items: list) -> list[ShelfmarkDownloadStatusItem]:
    """Convert service layer status items to API response items."""
    return [
        ShelfmarkDownloadStatusItem(
            source_id=d.source_id,
            title=d.title,
            author=d.author,
            status=d.status,
            status_message=d.status_message,
            progress=d.progress,
            source=d.source,
            source_display_name=d.source_display_name,
            format=d.format,
            size=d.size,
            cover_url=d.cover_url,
        )
        for d in items
    ]


@router.get("/status", response_model=ShelfmarkStatusResponse)
async def get_status():
    """
    Get current download status from Shelfmark.
    
    Returns all downloads: in_progress (queued, resolving, locating, downloading),
    complete, and failed (error, cancelled). Poll this endpoint to show progress.
    """
    result = await shelfmark_get_status()
    
    return ShelfmarkStatusResponse(
        in_progress=_convert_status_items(result.in_progress),
        complete=_convert_status_items(result.complete),
        failed=_convert_status_items(result.failed),
        error=result.error,
    )


# --- Cancel Download endpoint ---

class ShelfmarkCancelResponse(BaseModel):
    """Response from cancel endpoint."""
    success: bool
    error: str | None = None


@router.delete("/download/{source_id}", response_model=ShelfmarkCancelResponse)
async def cancel_download(source_id: str):
    """
    Cancel a download in Shelfmark.
    
    Cancels a download that is currently in progress.
    """
    logger.info("Shelfmark cancel: source_id=%s", source_id)
    
    result = await shelfmark_cancel_download(source_id)
    
    return ShelfmarkCancelResponse(
        success=result.success,
        error=result.error,
    )


# --- Retry Download endpoint ---

class ShelfmarkRetryResponse(BaseModel):
    """Response from retry endpoint."""
    success: bool
    error: str | None = None


@router.post("/download/{source_id}/retry", response_model=ShelfmarkRetryResponse)
async def retry_download(source_id: str):
    """
    Retry a failed download in Shelfmark.
    
    Retries a download that previously failed.
    """
    logger.info("Shelfmark retry: source_id=%s", source_id)
    
    result = await shelfmark_retry_download(source_id)
    
    return ShelfmarkRetryResponse(
        success=result.success,
        error=result.error,
    )


# --- Dismiss Downloads endpoint ---

class ShelfmarkDismissRequest(BaseModel):
    """Request body for dismissing downloads."""
    source_ids: list[str]


class ShelfmarkDismissResponse(BaseModel):
    """Response from dismiss endpoint."""
    success: bool
    error: str | None = None


@router.post("/dismiss", response_model=ShelfmarkDismissResponse)
async def dismiss_downloads(request: ShelfmarkDismissRequest):
    """
    Dismiss completed/failed downloads from Shelfmark's activity view.
    
    Removes downloads from the complete/failed lists.
    """
    logger.info("Shelfmark dismiss: count=%d", len(request.source_ids))
    
    result = await shelfmark_dismiss_many(request.source_ids)
    
    return ShelfmarkDismissResponse(
        success=result.success,
        error=result.error,
    )


# --- Series Cache endpoints ---

class SeriesPrefetchRequest(BaseModel):
    """Request body for prefetching series info."""
    books: list[dict]  # List of {"provider": "hardcover", "book_id": "123"}


class SeriesPrefetchResponse(BaseModel):
    """Response from prefetch endpoint."""
    status: str  # "started", "already_cached", etc.
    cache_hits: int
    to_fetch: int


@router.post("/series/prefetch", response_model=SeriesPrefetchResponse)
async def prefetch_series(request: SeriesPrefetchRequest):
    """
    Start prefetching series info for a list of books.
    
    This warms the backend cache so subsequent enrichment requests are instant.
    The actual fetching happens in the background via the SSE stream.
    
    Returns immediately with count of cache hits vs books to fetch.
    """
    cache_hits = 0
    to_fetch = []
    
    for book in request.books:
        provider = book.get("provider")
        book_id = book.get("book_id")
        if not provider or not book_id:
            continue
        
        cached = get_series_from_cache(provider, book_id)
        if cached is not None:
            cache_hits += 1
        else:
            to_fetch.append(book)
    
    logger.info("Series prefetch: %d cache hits, %d to fetch", cache_hits, len(to_fetch))
    
    if not to_fetch:
        return SeriesPrefetchResponse(
            status="already_cached",
            cache_hits=cache_hits,
            to_fetch=0,
        )
    
    return SeriesPrefetchResponse(
        status="started",
        cache_hits=cache_hits,
        to_fetch=len(to_fetch),
    )


@router.post("/series/prefetch-stream")
async def prefetch_series_stream(request: SeriesPrefetchRequest):
    """
    Prefetch series info for a list of books via Server-Sent Events.
    
    Same as enrich-series but intended for background prefetching.
    Results are cached in the backend for later use.
    """
    # Filter to only books not in cache
    to_fetch = []
    for book in request.books:
        provider = book.get("provider")
        book_id = book.get("book_id")
        if not provider or not book_id:
            continue
        
        cached = get_series_from_cache(provider, book_id)
        if cached is None:
            to_fetch.append(book)
    
    logger.info("Series prefetch stream: %d books to fetch", len(to_fetch))
    
    async def event_generator():
        async for event in shelfmark_enrich_series(to_fetch):
            yield f"data: {json.dumps(event)}\n\n"
    
    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )


class SeriesCacheStatsResponse(BaseModel):
    """Response with cache statistics."""
    size: int
    entries: list[str]


@router.get("/series/cache-stats", response_model=SeriesCacheStatsResponse)
async def get_cache_stats():
    """Get series cache statistics."""
    stats = get_series_cache_stats()
    return SeriesCacheStatsResponse(
        size=stats["size"],
        entries=stats["entries"],
    )


@router.post("/series/cache-clear")
async def clear_cache():
    """Clear the series cache."""
    clear_series_cache()
    return {"status": "cleared"}


class SeriesCachePopulateRequest(BaseModel):
    """Request body for populating series cache from DB data."""
    books: list[dict]  # [{hardcover_id, series_info: [{series_name, position}]}]


@router.post("/series/cache-populate")
async def populate_cache(request: SeriesCachePopulateRequest):
    """Populate series cache from DB data (no Shelfmark calls needed)."""
    populated = 0
    for book in request.books:
        hardcover_id = book.get("hardcover_id")
        series_info = book.get("series_info", [])
        
        if not hardcover_id or not series_info:
            continue
        
        # Use first series (primary) for cache
        primary_series = series_info[0] if series_info else None
        if primary_series:
            set_series_in_cache(
                provider="hardcover",
                book_id=str(hardcover_id),
                series_name=primary_series.get("series_name"),
                series_position=primary_series.get("position"),
                series_count=None,  # We don't have this from DB, but it's optional
            )
            populated += 1
    
    logger.info("Series cache populated from DB: %d books", populated)
    return {"status": "populated", "count": populated}
