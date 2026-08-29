import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useParams, Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuthor, useAuthorRefreshStatus, useMergeAuthorDirectories, useRefreshAuthor, useRemoveAuthor } from "../api/authors";
import { useSettings } from "../api/settings";
import { getImageUrl } from "../types";
import type { BookInAuthor, SeriesInAuthor, UnmatchedLocalFile } from "../types";
import BookCard from "../components/BookCard";
import BookTable from "../components/BookTable";
import MobileBookList from "../components/MobileBookList";
import SeriesGroup from "../components/SeriesGroup";
import SortControls from "../components/SortControls";
import ViewToggle from "../components/ViewToggle";
import SearchBar from "../components/SearchBar";
import { BookFilterDropdown, bookMatchesFilter, type BookFilterKey } from "../components/BookFilterDropdown";
import AuthorPortraitPickerDialog from "../components/AuthorPortraitPickerDialog";
import FixAuthorMatchDialog from "../components/FixAuthorMatchDialog";
import MetadataInfoDialog from "../components/MetadataInfoDialog";
import ShelfmarkSearchDialog from "../components/ShelfmarkSearchDialog";
import { useIsMobile } from "../hooks/useIsMobile";
import { compareTitles } from "../utils/titleSort";

const SORT_OPTIONS = [
  { value: "series", label: "By Series" },
  { value: "title", label: "Title A-Z" },
  { value: "-date", label: "Newest First" },
  { value: "date", label: "Oldest First" },
  { value: "owned", label: "Owned First" },
];

const UNMATCHED_FORMAT_STYLES: Record<string, string> = {
  epub: "bg-emerald-500/15 text-emerald-300",
  mobi: "bg-blue-500/15 text-blue-300",
  pdf: "bg-amber-500/15 text-amber-300",
  audiobook: "bg-purple-500/15 text-purple-300",
};

function formatFileSize(size: number | null): string {
  if (size == null || Number.isNaN(size)) return "Unknown size";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB"];
  let value = size / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function UnmatchedFileTag({ format }: { format: string | null }) {
  const key = (format || "").toLowerCase();
  const label = key === "audiobook" ? "AUDIO" : (key || "FILE").toUpperCase();
  const colorClass = UNMATCHED_FORMAT_STYLES[key] ?? "bg-slate-700 text-slate-300";
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${colorClass}`}>
      {label}
    </span>
  );
}

export default function AuthorDetailPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { id } = useParams<{ id: string }>();
  const authorId = Number(id);
  const { data: author, isLoading } = useAuthor(authorId);
  const { data: settings } = useSettings();
  const refreshAuthor = useRefreshAuthor();
  const { data: authorRefreshStatus } = useAuthorRefreshStatus();
  const removeAuthor = useRemoveAuthor();
  const mergeAuthorDirectories = useMergeAuthorDirectories();
  const isMobile = useIsMobile();
  const [sort, setSort] = useState("series");
  const [view, setView] = useState<"grid" | "table">("grid");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<BookFilterKey[]>([]);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const filterMenuRef = useRef<HTMLDivElement | null>(null);
  const [bioExpanded, setBioExpanded] = useState(false);
  const [portraitPickerOpen, setPortraitPickerOpen] = useState(false);
  const [portraitMenuOpen, setPortraitMenuOpen] = useState(false);
  const [refreshMenuOpen, setRefreshMenuOpen] = useState(false);
  const [fixMatchOpen, setFixMatchOpen] = useState(false);
  const [mergeFoldersOpen, setMergeFoldersOpen] = useState(false);
  const [mergeTargetDirectoryId, setMergeTargetDirectoryId] = useState<number | null>(null);
  const [selectedBookIds, setSelectedBookIds] = useState<Set<number>>(new Set());
  const [linkedFilePopoverPath, setLinkedFilePopoverPath] = useState<string | null>(null);
  const [urlBookModal, setUrlBookModal] = useState<{ id: number; title: string } | null>(null);
  const [shelfmarkSearchQuery, setShelfmarkSearchQuery] = useState<{ title: string; authorName: string | null; series?: string; authorSearch?: string } | null>(null);
  const [cacheProgress, setCacheProgress] = useState<{ current: number; total: number } | null>(null);
  const portraitMenuRef = useRef<HTMLDivElement | null>(null);
  const refreshMenuRef = useRef<HTMLDivElement | null>(null);
  const linkedFilePopoverRef = useRef<HTMLDivElement | null>(null);
  const authorName = author?.name ?? "Unknown author";
  const isAuthorRefreshRunning = authorRefreshStatus?.status === "refreshing";
  const isThisAuthorRefreshing = isAuthorRefreshRunning && authorRefreshStatus?.author_id === authorId;
  const handleSearch = useCallback((value: string) => setSearch(value), []);
  const toggleFilterValue = useCallback((value: BookFilterKey | "all") => {
    if (value === "all") {
      setFilters([]);
      return;
    }
    setFilters((current) => (
      current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value]
    ));
  }, []);
  const startAuthorRefresh = useCallback((mode: "full" | "new_releases") => {
    if (!author) return;
    setRefreshMenuOpen(false);
    refreshAuthor.mutate({ authorId: author.id, mode });
  }, [author, refreshAuthor]);

  useEffect(() => {
    if (!author) {
      setMergeTargetDirectoryId(null);
      return;
    }
    const preferredDirectory = author.author_directories.find((directory) => directory.is_primary) ?? author.author_directories[0];
    setMergeTargetDirectoryId(preferredDirectory?.id ?? null);
  }, [author]);

  useEffect(() => {
    if (!portraitMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (portraitMenuRef.current && !portraitMenuRef.current.contains(event.target as Node)) {
        setPortraitMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [portraitMenuOpen]);

  useEffect(() => {
    if (!refreshMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (refreshMenuRef.current && !refreshMenuRef.current.contains(event.target as Node)) {
        setRefreshMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [refreshMenuOpen]);

  useEffect(() => {
    if (!filterMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (filterMenuRef.current && !filterMenuRef.current.contains(event.target as Node)) {
        setFilterMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [filterMenuOpen]);

  useEffect(() => {
    if (!linkedFilePopoverPath) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (linkedFilePopoverRef.current && !linkedFilePopoverRef.current.contains(event.target as Node)) {
        setLinkedFilePopoverPath(null);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [linkedFilePopoverPath]);

  // Handle ?book=ID URL param to open metadata modal
  useEffect(() => {
    const bookIdParam = searchParams.get("book");
    if (!bookIdParam || !author?.books) return;
    
    const bookId = Number(bookIdParam);
    const book = author.books.find((b) => b.id === bookId);
    if (book) {
      setUrlBookModal({ id: book.id, title: book.title });
      // Clear the param from URL without navigation
      searchParams.delete("book");
      setSearchParams(searchParams, { replace: true });
    }
  }, [author?.books, searchParams, setSearchParams]);

  // Populate series cache from DB data when author page loads
  // This is instant (no Shelfmark calls) - we already have series info from Hardcover
  useEffect(() => {
    if (!author?.books?.length) return;
    
    // Get books with Hardcover IDs and series info
    const booksWithSeriesInfo = author.books
      .filter((b) => b.hardcover_id && b.series_info?.length)
      .map((b) => ({ hardcover_id: b.hardcover_id, series_info: b.series_info }));
    
    if (booksWithSeriesInfo.length === 0) return;
    
    // Populate cache from DB data (no external calls needed)
    fetch("/api/shelfmark/series/cache-populate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ books: booksWithSeriesInfo }),
    })
      .then((res) => res.json())
      .then((data) => {
        setCacheProgress({ current: data.count, total: booksWithSeriesInfo.length });
        // Clear after 2 seconds
        setTimeout(() => setCacheProgress(null), 2000);
      })
      .catch(() => {
        // Silent fail - cache populate is optional optimization
      });
  }, [author?.books]);

  const imgUrl = author ? getImageUrl(author.image_cached_path, author.image_url) : "";

  const searchNormalized = search.trim().toLowerCase();
  const filteredBooks = (author?.books ?? []).filter((book) => {
    // Apply search filter
    if (searchNormalized && !book.title.toLowerCase().includes(searchNormalized)) {
      return false;
    }
    // Apply book filters (owned/missing/format)
    if (filters.length > 0 && !filters.some((filter) => bookMatchesFilter(book, filter))) {
      return false;
    }
    return true;
  });
  const filteredUnmatchedLocalFiles: UnmatchedLocalFile[] = searchNormalized
    ? (author?.unmatched_local_files ?? []).filter((file) =>
      file.file_path.toLowerCase().includes(searchNormalized)
      || (file.linked_book_title ?? "").toLowerCase().includes(searchNormalized))
    : (author?.unmatched_local_files ?? []);

  // Sort books
  const sortedBooks = [...filteredBooks].sort((a, b) => {
    switch (sort) {
      case "title":
        return compareTitles(a.title, b.title);
      case "-date":
        return (b.release_date || "").localeCompare(a.release_date || "");
      case "date":
        return (a.release_date || "").localeCompare(b.release_date || "");
      case "owned":
        return (b.is_owned ? 1 : 0) - (a.is_owned ? 1 : 0);
      default:
        return 0;
    }
  });

  const filteredBookIds = new Set(sortedBooks.map((book) => book.id));
  const filteredSeries: SeriesInAuthor[] = (author?.series ?? [])
    .map((series) => ({
      ...series,
      books: series.books.filter((book) => filteredBookIds.has(book.book_id)),
    }))
    .filter((series) => series.books.length > 0);

  // Determine standalone books (not in any visible series)
  const booksInSeries = new Set<number>();
  filteredSeries.forEach((s) => s.books.forEach((b) => booksInSeries.add(b.book_id)));
  const standaloneBooks = sortedBooks.filter((b) => !booksInSeries.has(b.id));
  const showBulkIrcControls = !isMobile && view === "table";
  const selectedBooks = useMemo(
    () => sortedBooks.filter((book) => selectedBookIds.has(book.id)),
    [selectedBookIds, sortedBooks],
  );

  const bioTruncated = Boolean(author?.bio && author.bio.length > 400);
  const displayBio = bioExpanded ? author?.bio : author?.bio?.substring(0, 400);

  useEffect(() => {
    if (showBulkIrcControls) return;
    setSelectedBookIds((current) => (current.size === 0 ? current : new Set()));
  }, [showBulkIrcControls]);

  useEffect(() => {
    const visibleIds = new Set(sortedBooks.map((book) => book.id));
    setSelectedBookIds((current) => {
      const next = new Set(Array.from(current).filter((bookId) => visibleIds.has(bookId)));
      return next.size === current.size ? current : next;
    });
  }, [sortedBooks]);

  const toggleBookSelection = useCallback((bookId: number) => {
    setSelectedBookIds((current) => {
      const next = new Set(current);
      if (next.has(bookId)) {
        next.delete(bookId);
      } else {
        next.add(bookId);
      }
      return next;
    });
  }, []);

  const selectVisibleBooks = useCallback(() => {
    setSelectedBookIds(new Set(sortedBooks.map((book) => book.id)));
  }, [sortedBooks]);

  const selectMissingBooks = useCallback(() => {
    setSelectedBookIds(new Set(sortedBooks.filter((book) => !book.is_owned).map((book) => book.id)));
  }, [sortedBooks]);

  const clearSelectedBooks = useCallback(() => {
    setSelectedBookIds(new Set());
  }, []);

  const openIrcDownloads = useCallback(() => {
    if (selectedBooks.length === 0) return;
    navigate("/irc-downloads", {
      state: {
        selectedBooks: selectedBooks.map((book) => ({
          id: book.id,
          title: book.title,
          author_name: authorName,
          is_owned: book.is_owned,
        })),
      },
    });
  }, [authorName, navigate, selectedBooks]);

  const handleRemoveAuthor = useCallback(async () => {
    if (!author) return;
    const confirmed = window.confirm(
      `Remove ${author.name} and all of this author's books from the database?\n\nThis will not delete any files or folders.`,
    );
    if (!confirmed) return;

    await removeAuthor.mutateAsync(author.id);
    navigate("/", { replace: true });
  }, [author, navigate, removeAuthor]);

  if (isLoading || !author) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-slate-400">Loading...</div>
      </div>
    );
  }

  const renderBooks = () => {
    if (isMobile) {
      return <MobileBookList books={sortedBooks} showAuthor={false} />;
    }

    if (view === "table") {
      if (sort === "series") {
        return (
          <>
            {filteredSeries.map((s) => {
              const seriesBookIds = new Set(s.books.map((b) => b.book_id));
              const seriesFullBooks = sortedBooks.filter((b) => seriesBookIds.has(b.id));
              // Sort by series position
              seriesFullBooks.sort((a, b) => {
                const posA = s.books.find((sb) => sb.book_id === a.id)?.position ?? 9999;
                const posB = s.books.find((sb) => sb.book_id === b.id)?.position ?? 9999;
                return posA - posB || compareTitles(a.title, b.title);
              });
              const ownedCount = s.books.filter((b) => b.is_owned).length;
              return (
                <div key={s.id} className="mb-6">
                  <div className="flex items-center gap-3 mb-3">
                    <h3 className="text-lg font-semibold text-slate-200">{s.name}</h3>
                    <span className="text-sm text-slate-400">
                      <span className="text-emerald-400">{ownedCount}</span> / {s.books.length} books
                    </span>
                    <button
                      type="button"
                      onClick={() => setShelfmarkSearchQuery({ title: "", authorName: s.primary_author_name, series: s.name })}
                      className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-colors"
                      title="Search series in Shelfmark"
                    >
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                      </svg>
                    </button>
                  </div>
                  <BookTable
                    books={seriesFullBooks}
                    showAuthor={false}
                    authorName={author.name}
                    selectedBookIds={showBulkIrcControls ? selectedBookIds : undefined}
                    onToggleSelected={showBulkIrcControls ? toggleBookSelection : undefined}
                    virtualized={false}
                  />
                </div>
              );
            })}
            {standaloneBooks.length > 0 && (
              <div className="mb-6">
                <h3 className="text-lg font-semibold text-slate-200 mb-3">Standalone</h3>
                <BookTable
                  books={standaloneBooks}
                  showAuthor={false}
                  authorName={author.name}
                  selectedBookIds={showBulkIrcControls ? selectedBookIds : undefined}
                  onToggleSelected={showBulkIrcControls ? toggleBookSelection : undefined}
                  virtualized={false}
                />
              </div>
            )}
          </>
        );
      }
      return (
        <BookTable
          books={sortedBooks}
          showAuthor={false}
          authorName={author.name}
          selectedBookIds={showBulkIrcControls ? selectedBookIds : undefined}
          onToggleSelected={showBulkIrcControls ? toggleBookSelection : undefined}
        />
      );
    }

    // Grid view
    if (sort === "series") {
      return (
        <>
          {filteredSeries.map((s) => (
            <SeriesGroup key={s.id} series={s} allBooks={sortedBooks} authorName={author.name} />
          ))}
          {standaloneBooks.length > 0 && (
            <div className="mb-8">
              <h3 className="text-lg font-semibold text-slate-200 mb-4">Standalone</h3>
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-4">
                {standaloneBooks.map((book) => (
                  <BookCard key={book.id} book={book} authorName={author.name} />
                ))}
              </div>
            </div>
          )}
        </>
      );
    }

    return (
      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-4">
        {sortedBooks.map((book) => (
          <BookCard key={book.id} book={book} authorName={author.name} />
        ))}
      </div>
    );
  };

  return (
    <div>
      <Link to="/" className="text-slate-400 hover:text-emerald-400 text-sm mb-4 inline-flex items-center gap-1">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Back to Authors
      </Link>

      {/* Hero Section */}
      <div className={`${isMobile ? "mt-2 mb-6 block" : "mt-4 mb-8 flex gap-6"}`}>
        <div
          ref={portraitMenuRef}
          className={`group relative overflow-hidden rounded-lg bg-slate-700 ${isMobile ? "mx-auto mb-4 h-40 w-32" : "h-52 w-40 flex-shrink-0"}`}
        >
          {imgUrl ? (
            <img src={imgUrl} alt={author.name} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-5xl font-bold text-slate-500">
              {author.name.charAt(0)}
            </div>
          )}
          {!isMobile && (
            <div className="absolute bottom-2 left-2 right-2">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setPortraitMenuOpen((current) => !current);
                }}
                className="rounded-md border border-slate-500/60 bg-slate-900/70 px-1.5 py-1 text-slate-100 opacity-0 transition-opacity hover:bg-slate-800/90 group-hover:opacity-100"
                title="Author actions"
              >
                <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24">
                  <circle cx="5" cy="12" r="1.75" />
                  <circle cx="12" cy="12" r="1.75" />
                  <circle cx="19" cy="12" r="1.75" />
                </svg>
              </button>
              {portraitMenuOpen && (
                <div
                  className="absolute bottom-9 left-0 right-0 z-20 rounded-lg border border-slate-600 bg-slate-900/95 p-1 shadow-xl"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setPortraitMenuOpen(false);
                      setPortraitPickerOpen(true);
                    }}
                    className="flex w-full items-center rounded-md px-2.5 py-1.5 text-xs text-slate-200 transition-colors hover:bg-slate-800"
                  >
                    Choose Portrait
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="mb-2">
            <div className={`flex ${isMobile ? "flex-col items-start gap-2" : "items-center gap-3"}`}>
              <div>
                {(() => {
                  // Determine where clicking the author name should go
                  const hasOwnedBooks = author.book_count_local > 0;
                  const shouldOpenAbs = settings?.open_owned_in_abs && settings?.abs_enabled && hasOwnedBooks;
                  const hardcoverUrl = author.hardcover_slug ? `https://hardcover.app/authors/${author.hardcover_slug}` : null;
                  
                  const handleAuthorClick = () => {
                    if (shouldOpenAbs && settings?.abs_url) {
                      const absUrl = settings.abs_url.replace(/\/$/, "");
                      if (author.abs_author_id) {
                        window.open(`${absUrl}/author/${author.abs_author_id}`, "_blank", "noopener,noreferrer");
                      } else {
                        // Fallback: filter by author name
                        const filterValue = btoa(author.name);
                        window.open(`${absUrl}/library/${settings.abs_library_id}/bookshelf?filter=authors.${filterValue}`, "_blank", "noopener,noreferrer");
                      }
                    } else if (hardcoverUrl) {
                      window.open(hardcoverUrl, "_blank", "noopener,noreferrer");
                    }
                  };
                  
                  const isClickable = shouldOpenAbs || hardcoverUrl;
                  
                  return isClickable ? (
                    <h1 
                      className={`${isMobile ? "text-2xl" : "text-3xl"} font-bold cursor-pointer hover:text-emerald-400 transition-colors`}
                      onClick={handleAuthorClick}
                      title={shouldOpenAbs ? "Open in Audiobookshelf" : "Open in Hardcover"}
                    >
                      {author.name}
                    </h1>
                  ) : (
                    <h1 className={`${isMobile ? "text-2xl" : "text-3xl"} font-bold`}>{author.name}</h1>
                  );
                })()}
                {author.asin && (
                  <span className="text-xs text-slate-500 font-mono">ASIN: {author.asin}</span>
                )}
              </div>
              <div ref={refreshMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => setRefreshMenuOpen((current) => !current)}
                  disabled={refreshAuthor.isPending || isAuthorRefreshRunning}
                  className="inline-flex items-center gap-2 rounded-md border border-slate-600 bg-slate-800 px-3 py-1.5 text-sm text-slate-200 transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                  title="Refresh author"
                >
                  <svg className={`h-4 w-4 ${refreshAuthor.isPending || isThisAuthorRefreshing ? "animate-spin" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m14.836 2A8.001 8.001 0 005.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.356-2m15.356 2H15" />
                  </svg>
                  {isThisAuthorRefreshing ? "Refreshing..." : isAuthorRefreshRunning ? "Refresh In Progress" : refreshAuthor.isPending ? "Starting..." : "Refresh Author"}
                  <svg className="h-3.5 w-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {refreshMenuOpen && (
                  <div className="absolute left-0 top-full z-30 mt-1 w-56 rounded-lg border border-slate-600 bg-slate-900/95 p-1 shadow-xl">
                    <button
                      type="button"
                      onClick={() => startAuthorRefresh("full")}
                      className="flex w-full items-center rounded-md px-3 py-2 text-left text-sm text-slate-200 transition-colors hover:bg-slate-800"
                    >
                      Full Refresh
                    </button>
                    <button
                      type="button"
                      onClick={() => startAuthorRefresh("new_releases")}
                      className="flex w-full items-center rounded-md px-3 py-2 text-left text-sm text-slate-200 transition-colors hover:bg-slate-800"
                    >
                      Search for New Releases
                    </button>
                    <div className="my-1 border-t border-slate-700" />
                    <button
                      type="button"
                      onClick={() => {
                        setRefreshMenuOpen(false);
                        setFixMatchOpen(true);
                      }}
                      className="flex w-full items-center rounded-md px-3 py-2 text-left text-sm text-slate-200 transition-colors hover:bg-slate-800"
                    >
                      Fix Match
                    </button>
                    <div className="my-1 border-t border-slate-700" />
                    {settings?.abs_enabled && author?.abs_author_id && (
                      <button
                        type="button"
                        onClick={() => {
                          setRefreshMenuOpen(false);
                          if (settings?.abs_url) {
                            const absUrl = settings.abs_url.replace(/\/$/, "");
                            window.open(`${absUrl}/author/${author.abs_author_id}`, "_blank", "noopener,noreferrer");
                          }
                        }}
                        className="flex w-full items-center rounded-md px-3 py-2 text-left text-sm text-slate-200 transition-colors hover:bg-slate-800"
                      >
                        Open in Audiobookshelf
                      </button>
                    )}
                    {settings?.abs_enabled && !author?.abs_author_id && author?.name && (
                      <button
                        type="button"
                        onClick={() => {
                          setRefreshMenuOpen(false);
                          if (settings?.abs_url) {
                            const absUrl = settings.abs_url.replace(/\/$/, "");
                            const filterValue = btoa(author.name);
                            window.open(`${absUrl}/library/${settings.abs_library_id}/bookshelf?filter=authors.${filterValue}`, "_blank", "noopener,noreferrer");
                          }
                        }}
                        className="flex w-full items-center rounded-md px-3 py-2 text-left text-sm text-slate-200 transition-colors hover:bg-slate-800"
                      >
                        Search Audiobookshelf
                      </button>
                    )}
                    {author?.hardcover_slug && (
                      <button
                        type="button"
                        onClick={() => {
                          setRefreshMenuOpen(false);
                          window.open(`https://hardcover.app/authors/${author.hardcover_slug}`, "_blank", "noopener,noreferrer");
                        }}
                        className="flex w-full items-center rounded-md px-3 py-2 text-left text-sm text-slate-200 transition-colors hover:bg-slate-800"
                      >
                        Open in Hardcover
                      </button>
                    )}
                    {!author?.hardcover_slug && author?.name && (
                      <button
                        type="button"
                        onClick={() => {
                          setRefreshMenuOpen(false);
                          window.open(`https://hardcover.app/search?q=${encodeURIComponent(author.name)}`, "_blank", "noopener,noreferrer");
                        }}
                        className="flex w-full items-center rounded-md px-3 py-2 text-left text-sm text-slate-200 transition-colors hover:bg-slate-800"
                      >
                        Search Hardcover
                      </button>
                    )}
                    {settings?.shelfmark_enabled && author?.name && (
                      <button
                        type="button"
                        onClick={() => {
                          setRefreshMenuOpen(false);
                          // Pre-populate series cache from DB before author search
                          const booksWithSeriesInfo = author.books
                            .filter((b) => b.hardcover_id && b.series_info?.length)
                            .map((b) => ({ hardcover_id: b.hardcover_id, series_info: b.series_info }));
                          if (booksWithSeriesInfo.length > 0) {
                            fetch("/api/shelfmark/series/cache-populate", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ books: booksWithSeriesInfo }),
                            }).catch(() => {});
                          }
                          setShelfmarkSearchQuery({ title: "", authorName: null, authorSearch: author.name });
                        }}
                        className="flex w-full items-center rounded-md px-3 py-2 text-left text-sm text-slate-200 transition-colors hover:bg-slate-800"
                      >
                        Search Shelfmark
                      </button>
                    )}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={handleRemoveAuthor}
                disabled={removeAuthor.isPending}
                className="inline-flex items-center gap-2 rounded-md border border-rose-700 bg-rose-950/40 px-3 py-1.5 text-sm text-rose-200 transition-colors hover:bg-rose-900/50 disabled:cursor-not-allowed disabled:opacity-50"
                title="Remove this author and all linked books from the database without deleting files"
              >
                <svg className={`h-4 w-4 ${removeAuthor.isPending ? "animate-pulse" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 7h12M9 7V5h6v2m-7 4v6m4-6v6m4-6v6M5 7l1 12h12l1-12" />
                </svg>
                {removeAuthor.isPending ? "Removing..." : "Remove Author"}
              </button>
            </div>
            {removeAuthor.error && (
              <div className="mt-2 text-sm text-rose-300">
                {removeAuthor.error instanceof Error
                  ? removeAuthor.error.message
                  : "Unable to remove author"}
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-4 text-sm text-slate-400 mb-4">
            <span><span className="text-emerald-400 font-semibold">{author.book_count_local}</span> owned</span>
            <span><span className="text-slate-200 font-semibold">{author.book_count_total}</span> total books</span>
            <span><span className="text-slate-200 font-semibold">{author.series.length}</span> series</span>
            {author.book_count_hidden > 0 && (
              <Link
                to={`/books/hidden?author=${encodeURIComponent(author.name)}`}
                className="text-amber-400 hover:text-amber-300 transition-colors"
              >
                <span className="font-semibold">{author.book_count_hidden}</span> hidden
              </Link>
            )}
            {cacheProgress && (
              <span className="flex items-center gap-1.5 text-emerald-400">
                <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
                Cached {cacheProgress.current}/{cacheProgress.total}
              </span>
            )}
          </div>
          {author.author_directories.length > 0 && (
            <div className="mb-4">
              <div className="mb-1 flex items-center gap-3">
                <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Linked Folder Paths
                </div>
                {author.author_directories.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setMergeFoldersOpen((current) => !current)}
                    className="rounded-md border border-slate-600 bg-slate-800 px-2 py-1 text-[11px] font-medium text-slate-200 transition-colors hover:bg-slate-700"
                  >
                    {mergeFoldersOpen ? "Cancel Merge" : "Merge Folders"}
                  </button>
                )}
              </div>
              <div className="space-y-1">
                {author.author_directories.map((directory) => (
                  <div key={directory.id} className="flex items-start gap-2 text-sm text-slate-300">
                    <code className="break-all rounded bg-slate-800 px-2 py-1 text-xs text-slate-200">
                      {directory.dir_path}
                    </code>
                    {directory.is_primary && (
                      <span className="rounded bg-emerald-500/15 px-2 py-1 text-[11px] font-medium text-emerald-300">
                        Primary
                      </span>
                    )}
                  </div>
                ))}
              </div>
              {mergeFoldersOpen && author.author_directories.length > 1 && (
                <div className="mt-3 rounded-lg border border-slate-700 bg-slate-900/70 p-3">
                  <div className="mb-2 text-sm font-medium text-slate-200">Choose the folder to keep</div>
                  <div className="mb-3 text-xs text-slate-400">
                    Booksarr will move all books from the other linked author folders into the selected folder, update linked file paths, and remove the empty folder mappings. If conflicting file names already exist, the merge will stop instead of overwriting anything.
                  </div>
                  <div className="space-y-2">
                    {author.author_directories.map((directory) => (
                      <label
                        key={directory.id}
                        className="flex cursor-pointer items-start gap-2 rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800/70"
                      >
                        <input
                          type="radio"
                          name="merge-target-directory"
                          checked={mergeTargetDirectoryId === directory.id}
                          onChange={() => setMergeTargetDirectoryId(directory.id)}
                          className="mt-0.5"
                        />
                        <div className="flex min-w-0 items-center gap-2">
                          <code className="break-all text-xs text-slate-200">{directory.dir_path}</code>
                          {directory.is_primary && (
                            <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
                              Current primary
                            </span>
                          )}
                        </div>
                      </label>
                    ))}
                  </div>
                  {mergeAuthorDirectories.error && (
                    <div className="mt-3 text-xs text-rose-300">
                      {mergeAuthorDirectories.error instanceof Error
                        ? mergeAuthorDirectories.error.message
                        : "Unable to merge author folders"}
                    </div>
                  )}
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        if (!mergeTargetDirectoryId) return;
                        mergeAuthorDirectories.mutate(
                          {
                            authorId: author.id,
                            targetDirectoryId: mergeTargetDirectoryId,
                          },
                          {
                            onSuccess: () => {
                              setMergeFoldersOpen(false);
                            },
                          },
                        );
                      }}
                      disabled={!mergeTargetDirectoryId || mergeAuthorDirectories.isPending}
                      className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {mergeAuthorDirectories.isPending ? "Merging..." : "Merge Into Selected Folder"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setMergeFoldersOpen(false)}
                      className="rounded-md border border-slate-600 bg-slate-800 px-3 py-1.5 text-sm text-slate-200 transition-colors hover:bg-slate-700"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          {author.bio && (
            <div className="text-sm text-slate-300 leading-relaxed">
              <p className="whitespace-pre-line">{displayBio}{bioTruncated && !bioExpanded ? "..." : ""}</p>
              {bioTruncated && (
                <button
                  onClick={() => setBioExpanded(!bioExpanded)}
                  className="text-emerald-400 hover:underline mt-1"
                >
                  {bioExpanded ? "Show less" : "Read more"}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Unmatched Local Files */}
      {filteredUnmatchedLocalFiles.length > 0 && (
        <div className="mb-6 rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-200">
              Unmatched Local Files
            </span>
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-300">
              {filteredUnmatchedLocalFiles.length}
            </span>
          </div>
          <div className="divide-y divide-slate-700/50">
            {filteredUnmatchedLocalFiles.map((file) => {
              // Extract a search-friendly title from the file path
              const pathParts = file.file_path.split("/");
              const fileName = pathParts[pathParts.length - 1] || file.file_name;
              // Remove extension and clean up for search
              const searchTitle = fileName
                .replace(/\.(epub|pdf|mobi|azw3|azw|txt|fb2|cbz|cbr)$/i, "")
                .replace(/^\d+(\.\d+)?\s*-\s*/, "") // Remove leading position numbers like "0.1 - " or "1 - "
                .replace(/\s*\(\d{4}\)\s*$/, "") // Remove trailing year like "(2012)"
                .trim();

              return (
                <div key={file.file_path} className="py-1.5">
                  <div className="flex items-center gap-2">
                    <UnmatchedFileTag format={file.file_format} />
                    <code className="min-w-0 flex-1 truncate text-xs text-slate-300">{file.file_path}</code>
                    <span className="shrink-0 text-xs text-slate-500">{formatFileSize(file.file_size)}</span>
                    {/* Warning icon for linked files - positioned between file size and action buttons */}
                    {file.linked_book_id && (
                      <div className="relative shrink-0">
                        <button
                          type="button"
                          title="File linked to another author"
                          onClick={() => setLinkedFilePopoverPath(linkedFilePopoverPath === file.file_path ? null : file.file_path)}
                          className="rounded p-1 text-amber-400 transition-colors hover:bg-slate-700 hover:text-amber-300"
                        >
                          {/* Warning/exclamation icon */}
                          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                          </svg>
                        </button>
                        {/* Popover for linked file info */}
                        {linkedFilePopoverPath === file.file_path && (
                          <div
                            ref={linkedFilePopoverRef}
                            className="absolute right-0 top-full z-30 mt-1 w-64 rounded-lg border border-slate-600 bg-slate-900/95 p-3 shadow-xl"
                          >
                            <div className="mb-2 text-xs font-semibold text-slate-300">Linked to Another Author</div>
                            {file.linked_book_title && file.linked_author_id && file.linked_book_id && (
                              <div className="mb-1 text-xs text-slate-400">
                                <span className="text-slate-500">Book:</span>{" "}
                                <a
                                  href={`/authors/${file.linked_author_id}?book=${file.linked_book_id}`}
                                  onClick={(e) => {
                                    e.preventDefault();
                                    setLinkedFilePopoverPath(null);
                                    window.open(`/authors/${file.linked_author_id}?book=${file.linked_book_id}`, "_blank", "noopener,noreferrer");
                                  }}
                                  className="text-slate-200 underline hover:text-slate-100"
                                >
                                  {file.linked_book_title}
                                </a>
                              </div>
                            )}
                            {file.linked_author_id && file.linked_author_name && (
                              <div className="mb-2 text-xs text-slate-400">
                                <span className="text-slate-500">Author:</span>{" "}
                                <a
                                  href={`/authors/${file.linked_author_id}`}
                                  onClick={(e) => {
                                    e.preventDefault();
                                    setLinkedFilePopoverPath(null);
                                    window.open(`/authors/${file.linked_author_id}`, "_blank", "noopener,noreferrer");
                                  }}
                                  className="text-slate-200 underline hover:text-slate-100"
                                >
                                  {file.linked_author_name}
                                </a>
                              </div>
                            )}
                            {/* Action buttons for the linked book */}
                            <div className="flex gap-1 border-t border-slate-700 pt-2">
                              {settings?.abs_enabled && settings?.abs_url && file.linked_book_abs_id && (
                                <button
                                  type="button"
                                  title="Open in Audiobookshelf"
                                  onClick={() => {
                                    setLinkedFilePopoverPath(null);
                                    const absUrl = settings.abs_url!.replace(/\/$/, "");
                                    window.open(`${absUrl}/item/${file.linked_book_abs_id}`, "_blank", "noopener,noreferrer");
                                  }}
                                  className="rounded p-1.5 text-slate-400 transition-colors hover:bg-slate-700 hover:text-slate-200"
                                >
                                  <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                                  </svg>
                                </button>
                              )}
                              {file.linked_book_hardcover_id && (
                                <button
                                  type="button"
                                  title="Open in Hardcover"
                                  onClick={() => {
                                    setLinkedFilePopoverPath(null);
                                    window.open(`https://hardcover.app/books/${file.linked_book_hardcover_id}`, "_blank", "noopener,noreferrer");
                                  }}
                                  className="rounded p-1.5 text-slate-400 transition-colors hover:bg-slate-700 hover:text-slate-200"
                                >
                                  <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                                  </svg>
                                </button>
                              )}
                              {settings?.shelfmark_enabled && file.linked_book_title && (
                                <button
                                  type="button"
                                  title="Search Shelfmark"
                                  onClick={() => {
                                    setLinkedFilePopoverPath(null);
                                    setShelfmarkSearchQuery({
                                      title: file.linked_book_title!,
                                      authorName: file.linked_author_name ?? null,
                                    });
                                  }}
                                  className="rounded p-1.5 text-slate-400 transition-colors hover:bg-slate-700 hover:text-slate-200"
                                >
                                  <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                                  </svg>
                                </button>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                    {/* Action buttons */}
                    <div className="flex shrink-0 gap-1">
                      {/* ABS: Open if we have abs_book_id, otherwise search */}
                      {settings?.abs_enabled && settings?.abs_url && (
                        <button
                          type="button"
                          title={file.linked_book_abs_id ? "Open in Audiobookshelf" : "Search Audiobookshelf"}
                          onClick={() => {
                            const absUrl = settings.abs_url!.replace(/\/$/, "");
                            if (file.linked_book_abs_id) {
                              window.open(`${absUrl}/item/${file.linked_book_abs_id}`, "_blank", "noopener,noreferrer");
                            } else {
                              window.open(`${absUrl}/library/${settings.abs_library_id}/bookshelf?filter=search.${encodeURIComponent(searchTitle)}`, "_blank", "noopener,noreferrer");
                            }
                          }}
                          className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-700 hover:text-slate-200"
                        >
                          {/* Audio icon - always represents ABS */}
                          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                          </svg>
                        </button>
                      )}
                      <button
                        type="button"
                        title="Search Hardcover"
                        onClick={() => {
                          const params = new URLSearchParams({ q: searchTitle });
                          window.open(`https://hardcover.app/search?${params.toString()}`, "_blank", "noopener,noreferrer");
                        }}
                        className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-700 hover:text-slate-200"
                      >
                        {/* Open book icon - always represents Hardcover */}
                        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                        </svg>
                      </button>
                      {settings?.shelfmark_enabled && (
                        <button
                          type="button"
                          title="Search Shelfmark"
                          onClick={() => {
                            setShelfmarkSearchQuery({
                              title: searchTitle,
                              authorName: author?.name ?? null,
                            });
                          }}
                          className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-700 hover:text-slate-200"
                        >
                          {/* Search icon - always represents Shelfmark */}
                          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Sort + View Controls */}
      <div className={`mb-6 ${isMobile ? "space-y-3" : "flex items-center justify-between"}`}>
        <h2 className="text-xl font-semibold">Books</h2>
        <div className={`flex ${isMobile ? "flex-col gap-2" : "items-center gap-3"}`}>
          <SearchBar value={search} onChange={handleSearch} placeholder="Search this author..." />
          <BookFilterDropdown
            selected={filters}
            open={filterMenuOpen}
            onToggleOpen={() => setFilterMenuOpen((current) => !current)}
            onToggleValue={toggleFilterValue}
            onClear={() => setFilters([])}
            menuRef={filterMenuRef}
          />
          {isMobile ? (
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200"
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          ) : (
            <>
              <SortControls options={SORT_OPTIONS} value={sort} onChange={setSort} />
              <ViewToggle view={view} onChange={setView} />
            </>
          )}
        </div>
      </div>

      {showBulkIrcControls && sortedBooks.length > 0 && (
        <div className="mb-6 rounded-xl border border-slate-700 bg-slate-800/80 p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-2 text-sm text-slate-300">
              <span className="rounded-full bg-slate-700 px-3 py-1">
                {selectedBooks.length} selected
              </span>
              <span className="rounded-full bg-slate-700 px-3 py-1">
                {sortedBooks.filter((book) => !book.is_owned).length} missing in view
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={selectVisibleBooks}
                className="rounded-md border border-slate-600 bg-slate-700 px-3 py-2 text-sm text-slate-100 hover:bg-slate-600"
              >
                Select Visible
              </button>
              <button
                type="button"
                onClick={selectMissingBooks}
                className="rounded-md border border-slate-600 bg-slate-700 px-3 py-2 text-sm text-slate-100 hover:bg-slate-600"
              >
                Select Missing
              </button>
              <button
                type="button"
                onClick={clearSelectedBooks}
                disabled={selectedBooks.length === 0}
                className="rounded-md border border-slate-600 bg-slate-700 px-3 py-2 text-sm text-slate-100 hover:bg-slate-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={openIrcDownloads}
                disabled={selectedBooks.length === 0}
                className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Download Selected From IRC
              </button>
            </div>
          </div>
        </div>
      )}

      {sortedBooks.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-slate-400 text-lg">No matching books found</p>
        </div>
      ) : (
        renderBooks()
      )}
      <AuthorPortraitPickerDialog
        authorId={author.id}
        authorName={author.name}
        open={portraitPickerOpen}
        onClose={() => setPortraitPickerOpen(false)}
      />
      <FixAuthorMatchDialog
        open={fixMatchOpen}
        onClose={() => setFixMatchOpen(false)}
        authorId={author.id}
        authorName={author.name}
        currentHardcoverId={author.hardcover_id}
      />
      <MetadataInfoDialog
        bookId={urlBookModal?.id ?? null}
        title={urlBookModal?.title ?? ""}
        open={urlBookModal !== null}
        onClose={() => setUrlBookModal(null)}
      />
      <ShelfmarkSearchDialog
        bookId={null}
        title={shelfmarkSearchQuery?.title ?? ""}
        authorName={shelfmarkSearchQuery?.authorName ?? null}
        series={shelfmarkSearchQuery?.series}
        authorSearch={shelfmarkSearchQuery?.authorSearch}
        open={shelfmarkSearchQuery !== null}
        onClose={() => setShelfmarkSearchQuery(null)}
      />
    </div>
  );
}
