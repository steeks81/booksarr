import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import type { Book, BookInAuthor } from "../types";
import { getBookCoverPresentation, getImageUrl } from "../types";
import { useRefreshBook, useSetBookVisibility } from "../api/books";
import { useAbsLookupBook, useAbsSearchBook } from "../api/abs";
import { useSettings } from "../api/settings";
import CoverPickerDialog from "./CoverPickerDialog";
import IrcSearchDialog from "./IrcSearchDialog";
import ShelfmarkSearchDialog from "./ShelfmarkSearchDialog";
import BookDownloadSelector from "./BookDownloadSelector";
import MetadataInfoDialog from "./MetadataInfoDialog";
import { compareTitles } from "../utils/titleSort";
import { useWindowVirtualRange } from "../hooks/useWindowVirtualRange";

type BookLike = Book | BookInAuthor;
type TableSortKey = "title" | "series" | "year" | "rating" | "size";

function isFullBook(book: BookLike): book is Book {
  return "author_name" in book;
}

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


function formatSeriesPosition(book: BookLike): string {
  if (book.manual_series_name) {
    const pos = book.manual_series_position != null
      ? (Number.isInteger(book.manual_series_position) ? `#${book.manual_series_position}` : `#${book.manual_series_position.toFixed(1)}`)
      : "";
    return pos ? `${book.manual_series_name} ${pos}` : book.manual_series_name;
  }
  if (!("series_info" in book) || !book.series_info || book.series_info.length === 0) return "";
  const si = book.series_info[0];
  const pos = si.series_position != null
    ? (Number.isInteger(si.series_position) ? `#${si.series_position}` : `#${si.series_position.toFixed(1)}`)
    : "";
  const name = si.series_name ?? "";
  return pos ? `${name} ${pos}` : name;
}

const FORMAT_BADGES: { key: string; label: string; activeClass: string }[] = [
  { key: "epub", label: "EPUB", activeClass: "bg-emerald-500/15 text-emerald-300" },
  { key: "mobi", label: "MOBI", activeClass: "bg-blue-500/15 text-blue-300" },
  { key: "pdf", label: "PDF", activeClass: "bg-amber-500/15 text-amber-300" },
  { key: "audiobook", label: "AUDIO", activeClass: "bg-purple-500/15 text-purple-300" },
];

const FORMAT_BADGE_MAP: Record<string, { label: string; activeClass: string }> = Object.fromEntries(
  FORMAT_BADGES.map(({ key, label, activeClass }) => [key, { label, activeClass }]),
);

function FileFormatTag({ format }: { format: string | null }) {
  const key = (format || "").toLowerCase();
  const entry = FORMAT_BADGE_MAP[key];
  const label = entry?.label ?? (key ? key.toUpperCase() : "FILE");
  const colorClass = entry?.activeClass ?? "bg-slate-700 text-slate-300";
  return (
    <span
      className={`inline-flex flex-shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${colorClass}`}
    >
      {label}
    </span>
  );
}

function FormatBadges({ book }: { book: BookLike }) {
  const ownedFormats = new Set(
    book.local_files
      .map((file) => (file.file_format || "").toLowerCase())
      .filter(Boolean),
  );

  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {FORMAT_BADGES.map(({ key, label, activeClass }) => {
        const owned = ownedFormats.has(key);
        return (
          <span
            key={key}
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
              owned ? activeClass : "bg-slate-800 text-slate-500"
            }`}
            title={owned ? `${label} file available` : `No ${label} file`}
          >
            {label}
          </span>
        );
      })}
    </div>
  );
}

function ActionIconButton({
  label,
  onClick,
  disabled = false,
  preferBelow = false,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  preferBelow?: boolean;
  children: ReactNode;
}) {
  const [showTooltip, setShowTooltip] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  const handleEnter = () => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => setShowTooltip(true), 250);
  };

  const handleLeave = () => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setShowTooltip(false);
  };

  return (
    <div
      className="relative inline-flex"
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      onFocus={handleEnter}
      onBlur={handleLeave}
    >
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-600 bg-slate-700 text-slate-200 transition-colors hover:bg-slate-600 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {children}
      </button>
      {showTooltip && !disabled && (
        <div
          className={`pointer-events-none absolute right-0 z-[120] whitespace-nowrap rounded-md border border-slate-600 bg-slate-900 px-2 py-1 text-[11px] font-medium text-slate-100 shadow-lg ${
            preferBelow ? "top-full mt-2" : "bottom-full mb-2"
          }`}
        >
          {label}
        </div>
      )}
    </div>
  );
}

function SelectionToggle({
  selected,
  label,
  onToggle,
}: {
  selected: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={selected}
      aria-label={label}
      className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded-[4px] border transition-colors ${
        selected
          ? "border-emerald-500 bg-emerald-500/90 text-slate-950"
          : "border-slate-500 bg-slate-800/70 text-transparent hover:border-slate-300 hover:bg-slate-700"
      }`}
    >
      <svg className="h-2.5 w-2.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.25">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.25 8.25 6.5 11.5 12.75 4.75" />
      </svg>
    </button>
  );
}

export default function BookTable({
  books,
  showAuthor = true,
  authorName: contextAuthorName = null,
  authorId = null,
  selectedBookIds,
  onToggleSelected,
  scrollRequest,
  virtualized = true,
}: {
  books: BookLike[];
  showAuthor?: boolean;
  authorName?: string | null;
  authorId?: number | null;
  selectedBookIds?: Set<number>;
  onToggleSelected?: (bookId: number) => void;
  scrollRequest?: { id: number; index: number; sequence: number } | null;
  virtualized?: boolean;
}) {
  const refreshBook = useRefreshBook();
  const setBookVisibility = useSetBookVisibility();
  const absLookup = useAbsLookupBook();
  const absSearch = useAbsSearchBook();
  const { data: settings } = useSettings();
  const [absLookupPending, setAbsLookupPending] = useState<number | null>(null);
  const [absSearchPending, setAbsSearchPending] = useState<number | null>(null);
  const [coverPickerBook, setCoverPickerBook] = useState<{ id: number; title: string } | null>(null);
  const [ircSearchBook, setIrcSearchBook] = useState<{ id: number; title: string; authorName: string | null } | null>(null);
  const [shelfmarkSearchBook, setShelfmarkSearchBook] = useState<{ id: number; title: string; authorName: string | null; authorId: number | null; series: string | null } | null>(null);
  const [metadataInfoBook, setMetadataInfoBook] = useState<{ id: number; title: string } | null>(null);
  const [actionMenuBookId, setActionMenuBookId] = useState<number | null>(null);
  const [actionMenuPosition, setActionMenuPosition] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number } | null>(null);
  const actionMenuRef = useRef<HTMLDivElement | null>(null);
  const actionMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [sortKey, setSortKey] = useState<TableSortKey | null>(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const showSelectionColumn = Boolean(onToggleSelected);

  const handleSort = (nextKey: TableSortKey) => {
    setSortKey((currentKey) => {
      if (currentKey === nextKey) {
        setSortDirection((currentDirection) => currentDirection === "asc" ? "desc" : "asc");
        return currentKey;
      }
      setSortDirection("asc");
      return nextKey;
    });
  };

  const sortedBooks = useMemo(() => {
    const items = [...books];
    if (!sortKey) return items;

    items.sort((a, b) => {
      let comparison = 0;
      if (sortKey === "title") {
        comparison = compareTitles(a.title, b.title);
      } else if (sortKey === "series") {
        comparison = formatSeriesPosition(a).localeCompare(formatSeriesPosition(b)) || compareTitles(a.title, b.title);
      } else if (sortKey === "year") {
        comparison = (a.release_date || "").localeCompare(b.release_date || "") || compareTitles(a.title, b.title);
      } else if (sortKey === "rating") {
        comparison = (a.rating || 0) - (b.rating || 0) || compareTitles(a.title, b.title);
      } else if (sortKey === "size") {
        const sizeA = a.local_files.reduce((sum, f) => sum + (f.file_size ?? 0), 0);
        const sizeB = b.local_files.reduce((sum, f) => sum + (f.file_size ?? 0), 0);
        comparison = sizeA - sizeB || compareTitles(a.title, b.title);
      }
      return sortDirection === "asc" ? comparison : -comparison;
    });

    return items;
  }, [books, sortDirection, sortKey]);

  const renderSortIndicator = (key: TableSortKey) => {
    if (sortKey !== key) return null;
    return <span className="ml-1 text-emerald-400">{sortDirection === "asc" ? "▲" : "▼"}</span>;
  };
  const rowHeight = 64;
  const virtualRows = useWindowVirtualRange(bodyRef, sortedBooks.length, rowHeight, 12);
  const renderedIndexes = virtualized
    ? virtualRows.virtualIndexes
    : sortedBooks.map((_, index) => index);
  const bottomSpacerHeight = virtualized
    ? virtualRows.totalSize - virtualRows.offsetTop - virtualRows.virtualIndexes.length * rowHeight
    : 0;

  useEffect(() => {
    if (!scrollRequest) return;
    const index = sortedBooks.findIndex((book) => book.id === scrollRequest.id);
    virtualRows.scrollToIndex(index === -1 ? scrollRequest.index : index);
  }, [scrollRequest, sortedBooks, virtualRows.scrollToIndex]);

  useEffect(() => {
    if (!actionMenuBookId) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (actionMenuRef.current?.contains(target) || actionMenuTriggerRef.current?.contains(target)) {
        return;
      }
      setActionMenuBookId(null);
      setActionMenuPosition(null);
    };

    const handleScroll = () => {
      setActionMenuBookId(null);
      setActionMenuPosition(null);
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleScroll);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleScroll);
    };
  }, [actionMenuBookId]);

  const openActionMenu = useCallback((bookId: number, triggerElement: HTMLButtonElement) => {
    if (actionMenuBookId === bookId) {
      setActionMenuBookId(null);
      setActionMenuPosition(null);
      return;
    }
    const rect = triggerElement.getBoundingClientRect();
    const menuWidth = 224; // w-56 = 14rem = 224px
    const menuHeight = 420; // estimated menu height
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const spaceAbove = rect.top - 8;
    const showAbove = spaceBelow < menuHeight && spaceAbove > spaceBelow;
    
    const left = Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8);
    let maxHeight: number;
    
    if (showAbove) {
      // Position above: use bottom anchoring (distance from viewport bottom to button top)
      const bottom = window.innerHeight - rect.top + 4;
      maxHeight = Math.min(menuHeight, spaceAbove);
      setActionMenuPosition({ left: Math.max(8, left), bottom, top: undefined, maxHeight: Math.max(200, maxHeight) });
    } else {
      // Position below button
      const top = rect.bottom + 4;
      maxHeight = Math.min(menuHeight, spaceBelow);
      setActionMenuPosition({ left: Math.max(8, left), top, bottom: undefined, maxHeight: Math.max(200, maxHeight) });
    }
    
    setActionMenuBookId(bookId);
    actionMenuTriggerRef.current = triggerElement;
  }, [actionMenuBookId]);

  const toggleExpanded = (bookId: number) => {
    setExpandedRows((current) => {
      const next = new Set(current);
      if (next.has(bookId)) {
        next.delete(bookId);
      } else {
        next.add(bookId);
      }
      return next;
    });
  };

  const detailColSpan = (showAuthor ? 8 : 7) + (showSelectionColumn ? 1 : 0);

  return (
    <>
      <div className="rounded-lg border border-slate-700 bg-slate-800 overflow-x-auto overflow-y-visible">
        <table className="w-full text-sm text-left">
          <thead className="border-b border-slate-700 bg-slate-800/80 text-[11px] uppercase tracking-wide text-slate-400">
            <tr>
              {showSelectionColumn && <th className="px-4 py-2 w-10"></th>}
              <th className="px-4 py-2 w-12"></th>
              <th className="px-4 py-2">
                <button type="button" onClick={() => handleSort("title")} className="hover:text-slate-200 transition-colors">
                  Book Title{renderSortIndicator("title")}
                </button>
              </th>
              {showAuthor && <th className="px-4 py-2"></th>}
              <th className="px-4 py-2">
                <button type="button" onClick={() => handleSort("series")} className="hover:text-slate-200 transition-colors">
                  Series{renderSortIndicator("series")}
                </button>
              </th>
              <th className="px-4 py-2 text-right">
                <button type="button" onClick={() => handleSort("year")} className="hover:text-slate-200 transition-colors">
                  Year{renderSortIndicator("year")}
                </button>
              </th>
              <th className="px-4 py-2 text-right">
                <button type="button" onClick={() => handleSort("rating")} className="hover:text-slate-200 transition-colors">
                  Rating{renderSortIndicator("rating")}
                </button>
              </th>
              <th className="px-4 py-2 text-right">
                <button type="button" onClick={() => handleSort("size")} className="hover:text-slate-200 transition-colors">
                  Size{renderSortIndicator("size")}
                </button>
              </th>
              <th className="px-4 py-2 text-right"></th>
            </tr>
          </thead>
          <tbody ref={bodyRef} className="divide-y divide-slate-700">
            {virtualized && virtualRows.offsetTop > 0 && (
              <tr aria-hidden="true">
                <td colSpan={detailColSpan} style={{ height: virtualRows.offsetTop, padding: 0 }} />
              </tr>
            )}
            {renderedIndexes.map((index) => {
              const book = sortedBooks[index];
              if (!book) return null;
              const imgUrl = getImageUrl(
                book.cover_image_cached_path,
                "cover_image_url" in book ? book.cover_image_url : null
              );
              const coverPresentation = getBookCoverPresentation(book.cover_aspect_ratio);
              const authorId = isFullBook(book) ? book.author_id : undefined;
              const authorName = isFullBook(book) ? book.author_name : undefined;
              const seriesStr = formatSeriesPosition(book);
              const isExpanded = expandedRows.has(book.id);
              const localFiles = [...book.local_files].sort((a, b) => a.file_path.localeCompare(b.file_path));
              const isSelected = selectedBookIds?.has(book.id) ?? false;

              return (
                <Fragment key={book.id}>
                  <tr
                    key={book.id}
                    className={`transition-colors ${isSelected ? "bg-emerald-500/10 hover:bg-emerald-500/15" : "hover:bg-slate-700/50"}`}
                  >
                    {showSelectionColumn && (
                      <td className="px-4 py-2 text-center">
                        <SelectionToggle
                          selected={isSelected}
                          onToggle={() => onToggleSelected?.(book.id)}
                          label={`Select ${book.title}`}
                        />
                      </td>
                    )}
                    <td className="px-4 py-2">
                      <div className={`w-8 h-12 rounded overflow-hidden flex-shrink-0 ${coverPresentation.frameClassName}`}>
                        {imgUrl ? (
                          coverPresentation.innerClassName ? (
                            <div className="flex h-full w-full items-center justify-center p-0.5">
                              <img
                                src={imgUrl}
                                alt=""
                                className={coverPresentation.imageClassName}
                                decoding="async"
                                loading="lazy"
                              />
                            </div>
                          ) : (
                            <img
                              src={imgUrl}
                              alt=""
                              className={coverPresentation.imageClassName}
                              decoding="async"
                              loading="lazy"
                            />
                          )
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-[8px] text-slate-500 p-0.5 text-center leading-tight">
                            {book.title.substring(0, 20)}
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      {book.hardcover_slug ? (
                        <a
                          href={`https://hardcover.app/books/${book.hardcover_slug}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium text-slate-200 hover:text-emerald-400 transition-colors"
                        >
                          {book.title}
                        </a>
                      ) : (
                        <span className="font-medium text-slate-200">{book.title}</span>
                      )}
                      <FormatBadges book={book} />
                    </td>
                    {showAuthor && (
                      <td className="px-4 py-2">
                        {authorId ? (
                          <Link
                            to={`/authors/${authorId}`}
                            className="text-slate-400 hover:text-emerald-400 transition-colors"
                          >
                            {authorName}
                          </Link>
                        ) : (
                          <span className="text-slate-400">-</span>
                        )}
                      </td>
                    )}
                    <td className="px-4 py-2 text-slate-400 text-xs">
                      {seriesStr || "-"}
                    </td>
                    <td className="px-4 py-2 text-right text-slate-400 whitespace-nowrap">
                      {book.release_date ? book.release_date.substring(0, 4) : "-"}
                    </td>
                    <td className="px-4 py-2 text-right text-slate-400">
                      {book.rating ? book.rating.toFixed(1) : "-"}
                    </td>
                    <td className="px-4 py-2 text-right text-slate-400 whitespace-nowrap">
                      {localFiles.length > 0
                        ? formatFileSize(localFiles.reduce((sum, f) => sum + (f.file_size ?? 0), 0))
                        : "-"}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {/* Split button: Metadata Info + dropdown */}
                        <div className="inline-flex">
                          <button
                            type="button"
                            onClick={() => setMetadataInfoBook({ id: book.id, title: book.title })}
                            className="inline-flex items-center rounded-l-md border border-slate-600 bg-slate-700 px-3 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-600"
                          >
                            Metadata Info
                          </button>
                          <button
                            type="button"
                            onClick={(e) => openActionMenu(book.id, e.currentTarget)}
                            className="inline-flex items-center rounded-r-md border border-l-0 border-slate-600 bg-slate-700 px-2 py-2 text-slate-400 transition-colors hover:bg-slate-600 hover:text-slate-200"
                          >
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                            </svg>
                          </button>
                        </div>
                        {/* Expand/collapse button */}
                        <ActionIconButton
                          label={isExpanded ? "Hide file paths" : "Show file paths"}
                          onClick={() => toggleExpanded(book.id)}
                          disabled={localFiles.length === 0}
                          preferBelow={index === 0}
                        >
                          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            {isExpanded ? (
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7-7-7 7" />
                            ) : (
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7 7 7-7" />
                            )}
                          </svg>
                        </ActionIconButton>
                      </div>
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr className="bg-slate-800/20">
                      <td colSpan={detailColSpan} className="px-4 pb-4 pt-0">
                        <div className="ml-14 border-t border-slate-700/70 px-1 pt-3">
                          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                            Local Files
                          </div>
                          <div className="space-y-1.5">
                            {localFiles.map((file) => (
                              <div
                                key={file.id}
                                className="flex items-start justify-between gap-4 px-0 py-1.5"
                              >
                                <div className="flex min-w-0 flex-1 items-start gap-2">
                                  <FileFormatTag format={file.file_format} />
                                  <div className="min-w-0 flex-1 break-all text-xs text-slate-300">
                                    {file.file_path}
                                  </div>
                                </div>
                                <div className="shrink-0 whitespace-nowrap pl-4 text-xs text-slate-500">
                                  {formatFileSize(file.file_size)}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {bottomSpacerHeight > 0 && (
              <tr aria-hidden="true">
                <td
                  colSpan={detailColSpan}
                  style={{
                    height: bottomSpacerHeight,
                    padding: 0,
                  }}
                />
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <CoverPickerDialog
        bookId={coverPickerBook?.id ?? null}
        title={coverPickerBook?.title ?? ""}
        open={coverPickerBook !== null}
        onClose={() => setCoverPickerBook(null)}
      />
      <IrcSearchDialog
        bookId={ircSearchBook?.id ?? null}
        title={ircSearchBook?.title ?? ""}
        authorName={ircSearchBook?.authorName ?? null}
        open={ircSearchBook !== null}
        onClose={() => setIrcSearchBook(null)}
      />
      <ShelfmarkSearchDialog
        bookId={shelfmarkSearchBook?.id ?? null}
        title={shelfmarkSearchBook?.title ?? ""}
        authorName={shelfmarkSearchBook?.authorName ?? null}
        authorId={shelfmarkSearchBook?.authorId ?? authorId}
        series={shelfmarkSearchBook?.series}
        open={shelfmarkSearchBook !== null}
        onClose={() => setShelfmarkSearchBook(null)}
      />
      <MetadataInfoDialog
        bookId={metadataInfoBook?.id ?? null}
        title={metadataInfoBook?.title ?? ""}
        open={metadataInfoBook !== null}
        onClose={() => setMetadataInfoBook(null)}
      />
      {/* Action menu portal */}
      {actionMenuBookId !== null && actionMenuPosition && createPortal(
        (() => {
          const menuBook = sortedBooks.find((b) => b.id === actionMenuBookId);
          if (!menuBook) return null;
          const menuLocalFiles = menuBook.local_files ?? [];
          const menuAuthorName = isFullBook(menuBook) ? menuBook.author_name : null;
          return (
            <div
              ref={actionMenuRef}
              className="fixed z-[140] w-56 overflow-y-auto rounded-lg border border-slate-600 bg-slate-900/95 p-1 shadow-xl"
              style={{ 
                left: actionMenuPosition.left, 
                top: actionMenuPosition.top, 
                bottom: actionMenuPosition.bottom, 
                maxHeight: actionMenuPosition.maxHeight 
              }}
            >
              <button
                type="button"
                onClick={() => {
                  setActionMenuBookId(null);
                  setActionMenuPosition(null);
                  setMetadataInfoBook({ id: menuBook.id, title: menuBook.title });
                }}
                className="flex w-full items-center rounded-md px-3 py-2 text-left text-sm text-slate-200 transition-colors hover:bg-slate-800"
              >
                Metadata Info
              </button>
              <button
                type="button"
                onClick={() => {
                  setActionMenuBookId(null);
                  setActionMenuPosition(null);
                  setCoverPickerBook({ id: menuBook.id, title: menuBook.title });
                }}
                className="flex w-full items-center rounded-md px-3 py-2 text-left text-sm text-slate-200 transition-colors hover:bg-slate-800"
              >
                Choose Poster
              </button>
              <div className="my-1 border-t border-slate-700" />
              <button
                type="button"
                onClick={() => {
                  setActionMenuBookId(null);
                  setActionMenuPosition(null);
                  refreshBook.mutate(menuBook.id);
                }}
                disabled={refreshBook.isPending}
                className="flex w-full items-center rounded-md px-3 py-2 text-left text-sm text-slate-200 transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Refresh
              </button>
              <BookDownloadSelector
                bookId={menuBook.id}
                localFiles={menuLocalFiles}
                disabled={!menuBook.is_owned}
                align="left"
                direction="down"
                wrapperClassName="flex w-full"
                menuWidthClassName="w-[18rem]"
                onDownloadStart={() => {
                  setActionMenuBookId(null);
                  setActionMenuPosition(null);
                }}
                renderTrigger={({ toggle, disabled, hasMultiple }) => (
                  <button
                    type="button"
                    onClick={toggle}
                    disabled={disabled}
                    className="flex w-full items-center rounded-md px-3 py-2 text-left text-sm text-slate-200 transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {hasMultiple ? "Download..." : "Download Book"}
                  </button>
                )}
              />
              <div className="my-1 border-t border-slate-700" />
              {menuBook.is_owned && menuLocalFiles.length > 0 && settings?.abs_enabled && (
                <button
                  type="button"
                  onClick={async () => {
                    if (menuBook.abs_book_id && settings?.abs_url) {
                      const absUrl = settings.abs_url.replace(/\/$/, "");
                      setActionMenuBookId(null);
                      setActionMenuPosition(null);
                      window.open(`${absUrl}/item/${menuBook.abs_book_id}`, "_blank", "noopener,noreferrer");
                      return;
                    }
                    const filePath = menuLocalFiles[0]?.file_path;
                    if (!filePath) return;
                    setAbsLookupPending(menuBook.id);
                    try {
                      const result = await absLookup.mutateAsync(filePath);
                      if (result.found && result.abs_url) {
                        setActionMenuBookId(null);
                        setActionMenuPosition(null);
                        window.open(result.abs_url, "_blank", "noopener,noreferrer");
                      }
                    } finally {
                      setAbsLookupPending(null);
                    }
                  }}
                  disabled={absLookupPending === menuBook.id}
                  className="flex w-full items-center rounded-md px-3 py-2 text-left text-sm text-slate-200 transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {absLookupPending === menuBook.id ? "Looking up..." : "Open in Audiobookshelf"}
                </button>
              )}
              {!menuBook.is_owned && settings?.abs_enabled && (
                <button
                  type="button"
                  onClick={async () => {
                    setAbsSearchPending(menuBook.id);
                    try {
                      const result = await absSearch.mutateAsync({
                        title: menuBook.title,
                        author_name: menuAuthorName ?? contextAuthorName ?? undefined,
                      });
                      if (result.found && result.abs_url) {
                        setActionMenuBookId(null);
                        setActionMenuPosition(null);
                        window.open(result.abs_url, "_blank", "noopener,noreferrer");
                      } else {
                        setActionMenuBookId(null);
                        setActionMenuPosition(null);
                        alert("Not found in Audiobookshelf");
                      }
                    } finally {
                      setAbsSearchPending(null);
                    }
                  }}
                  disabled={absSearchPending === menuBook.id}
                  className="flex w-full items-center rounded-md px-3 py-2 text-left text-sm text-slate-200 transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {absSearchPending === menuBook.id ? "Searching..." : "Search Audiobookshelf"}
                </button>
              )}
              {menuBook.hardcover_slug && (
                <button
                  type="button"
                  onClick={() => {
                    setActionMenuBookId(null);
                    setActionMenuPosition(null);
                    window.open(`https://hardcover.app/books/${menuBook.hardcover_slug}`, "_blank", "noopener,noreferrer");
                  }}
                  className="flex w-full items-center rounded-md px-3 py-2 text-left text-sm text-slate-200 transition-colors hover:bg-slate-800"
                >
                  Open in Hardcover
                </button>
              )}
              {!menuBook.hardcover_slug && menuBook.title && (
                <button
                  type="button"
                  onClick={() => {
                    setActionMenuBookId(null);
                    setActionMenuPosition(null);
                    window.open(`https://hardcover.app/search?q=${encodeURIComponent(menuBook.title)}`, "_blank", "noopener,noreferrer");
                  }}
                  className="flex w-full items-center rounded-md px-3 py-2 text-left text-sm text-slate-200 transition-colors hover:bg-slate-800"
                >
                  Search Hardcover
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setActionMenuBookId(null);
                  setActionMenuPosition(null);
                  setIrcSearchBook({
                    id: menuBook.id,
                    title: menuBook.title,
                    authorName: menuAuthorName ?? contextAuthorName ?? null,
                  });
                }}
                className="flex w-full items-center rounded-md px-3 py-2 text-left text-sm text-slate-200 transition-colors hover:bg-slate-800"
              >
                Search IRC
              </button>
              {settings?.shelfmark_enabled && (
                <button
                  type="button"
                  onClick={() => {
                    setActionMenuBookId(null);
                    setActionMenuPosition(null);
                    setShelfmarkSearchBook({
                      id: menuBook.id,
                      title: menuBook.title,
                      authorName: menuAuthorName ?? contextAuthorName ?? null,
                      authorId: isFullBook(menuBook) ? menuBook.author_id : authorId,
                      series: menuBook.series_info?.[0]?.series_name ?? null,
                    });
                  }}
                  className="flex w-full items-center rounded-md px-3 py-2 text-left text-sm text-slate-200 transition-colors hover:bg-slate-800"
                >
                  Search Shelfmark
                </button>
              )}
              <div className="my-1 border-t border-slate-700" />
              <button
                type="button"
                onClick={() => {
                  setActionMenuBookId(null);
                  setActionMenuPosition(null);
                  setBookVisibility.mutate({ bookId: menuBook.id, action: "hide" });
                }}
                disabled={setBookVisibility.isPending}
                className="flex w-full items-center rounded-md px-3 py-2 text-left text-sm text-rose-300 transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Hide Book
              </button>
            </div>
          );
        })(),
        document.body
      )}
    </>
  );
}
