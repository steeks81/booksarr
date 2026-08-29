import { useState } from "react";
import type { SeriesInAuthor, BookInAuthor } from "../types";
import BookCard from "./BookCard";
import ShelfmarkSearchDialog from "./ShelfmarkSearchDialog";

export default function SeriesGroup({
  series,
  allBooks,
  authorName,
}: {
  series: SeriesInAuthor;
  allBooks: BookInAuthor[];
  authorName: string;
}) {
  const ownedCount = series.books.filter((b) => b.is_owned).length;
  const [shelfmarkOpen, setShelfmarkOpen] = useState(false);

  return (
    <div className="mb-8">
      <div className="flex items-center gap-3 mb-4">
        <h3 className="text-lg font-semibold text-slate-200">{series.name}</h3>
        <span className="text-sm text-slate-400">
          <span className="text-emerald-400">{ownedCount}</span> / {series.books.length} books
        </span>
        <button
          type="button"
          onClick={() => setShelfmarkOpen(true)}
          className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-colors"
          title="Search series in Shelfmark"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </button>
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-4">
        {series.books.map((sb) => {
          const fullBook = allBooks.find((b) => b.id === sb.book_id);
          if (!fullBook) return null;
          return (
            <div key={sb.book_id} className="relative">
              {sb.position != null && (
                <div className="absolute -top-2 -left-2 z-10 bg-slate-700 border border-slate-600 rounded-full w-6 h-6 flex items-center justify-center text-xs font-bold text-slate-300">
                  {Number.isInteger(sb.position) ? sb.position : sb.position.toFixed(1)}
                </div>
              )}
              <BookCard book={fullBook} authorName={authorName} />
            </div>
          );
        })}
      </div>
      <ShelfmarkSearchDialog
        bookId={null}
        title=""
        authorName={series.primary_author_name}
        series={series.name}
        open={shelfmarkOpen}
        onClose={() => setShelfmarkOpen(false)}
      />
    </div>
  );
}
