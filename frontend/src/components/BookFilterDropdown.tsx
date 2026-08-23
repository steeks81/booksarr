import type { BookInAuthor, Book } from "../types";

export const BOOK_FILTER_OPTIONS = [
  { value: "all", label: "All Books" },
  { value: "missing", label: "Missing" },
  { value: "owned", label: "Owned" },
  { value: "epub", label: "EPUB" },
  { value: "mobi", label: "MOBI" },
  { value: "pdf", label: "PDF" },
  { value: "audiobook", label: "Audiobook" },
] as const;

export type BookFilterKey = Exclude<(typeof BOOK_FILTER_OPTIONS)[number]["value"], "all">;

type BookLike = Book | BookInAuthor;

export function bookMatchesFilter(book: BookLike, filter: BookFilterKey): boolean {
  if (filter === "missing") return !book.is_owned;
  if (filter === "owned") return book.is_owned;

  return book.local_files.some((file) => (file.file_format || "").toLowerCase() === filter);
}

export function getBookFilterLabel(selected: BookFilterKey[]) {
  if (selected.length === 0) return "All Books";
  if (selected.length === 1) {
    return BOOK_FILTER_OPTIONS.find((option) => option.value === selected[0])?.label ?? "All Books";
  }
  return `${selected.length} Filters`;
}

export function BookFilterDropdown({
  selected,
  open,
  onToggleOpen,
  onToggleValue,
  onClear,
  menuRef,
}: {
  selected: BookFilterKey[];
  open: boolean;
  onToggleOpen: () => void;
  onToggleValue: (value: BookFilterKey | "all") => void;
  onClear: () => void;
  menuRef: { current: HTMLDivElement | null };
}) {
  return (
    <div ref={(node) => { menuRef.current = node; }} className="relative">
      <button
        type="button"
        onClick={onToggleOpen}
        className="min-w-[140px] rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-sm text-slate-200 flex items-center justify-between gap-3"
      >
        <span className="truncate">{getBookFilterLabel(selected)}</span>
        <svg className="h-4 w-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-2 w-56 rounded-lg border border-slate-600 bg-slate-800 p-2 shadow-xl">
          <div className="mb-2 flex items-center justify-between px-1">
            <span className="text-xs font-medium text-slate-400">
              {selected.length === 0 ? "All books shown" : `${selected.length} selected`}
            </span>
            <button
              type="button"
              onClick={onClear}
              className="text-xs text-emerald-400 hover:text-emerald-300"
            >
              Clear
            </button>
          </div>
          <div className="space-y-1">
            {BOOK_FILTER_OPTIONS.map((option) => (
              <label
                key={option.value}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-200 hover:bg-slate-700"
              >
                <input
                  type="checkbox"
                  checked={option.value === "all" ? selected.length === 0 : selected.includes(option.value as BookFilterKey)}
                  onChange={() => onToggleValue(option.value as BookFilterKey | "all")}
                  className="rounded border-slate-600 bg-slate-700 text-emerald-500 focus:ring-emerald-500"
                />
                <span className="truncate">{option.label}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
