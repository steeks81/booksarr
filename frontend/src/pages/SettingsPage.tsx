import { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { useSettings, useUpdateSettings, useScanStatus, useTriggerScan, useResetData, useApiUsage } from "../api/settings";
import { useAbsSyncAuthorImages, useAbsSyncStatus } from "../api/abs";
import { useIrcSettings } from "../api/irc";
import { useQueryClient } from "@tanstack/react-query";
import type { ScanSummary, VisibilityCategories } from "../types";

const VISIBILITY_OPTIONS: Array<{
  key: keyof VisibilityCategories;
  label: string;
  description: string;
}> = [
  {
    key: "standard_books",
    label: "Standard Books",
    description: "Regular Hardcover books that are not classified into a more specific bucket.",
  },
  {
    key: "short_fiction",
    label: "Short Fiction",
    description: "Novellas and short stories.",
  },
  {
    key: "collections_and_compilations",
    label: "Collections & Compilations",
    description: "Hardcover-classified collections and books flagged with compilation=true.",
  },
  {
    key: "likely_collections_by_title",
    label: "Likely Collections by Title Heuristic",
    description: "Collection-like bundles inferred from the title, such as Value Collection, boxed sets, omnibuses, and similar bundle naming.",
  },
  {
    key: "graphic_and_alternate_formats",
    label: "Graphic & Alternate Formats",
    description: "Graphic novels, poetry, web novels, and light novels.",
  },
  {
    key: "research_non_book_material",
    label: "Research / Non-Book Material",
    description: "Research papers and other non-standard book material.",
  },
  {
    key: "fan_fiction",
    label: "Fan Fiction",
    description: "Hardcover items categorized as fan fiction.",
  },
  {
    key: "valid_isbn",
    label: "Valid ISBN",
    description: "Only show books that have at least one valid ISBN from local metadata, Hardcover, Google, or Open Library.",
  },
  {
    key: "non_english_books",
    label: "Non-English Books",
    description: "Books with a detected language outside English.",
  },
  {
    key: "upcoming_unreleased",
    label: "Upcoming / Unreleased",
    description: "Books with a future release date.",
  },
  {
    key: "pending_hardcover_records",
    label: "Pending Hardcover Records",
    description: "Books where Hardcover state is pending rather than normalized.",
  },
  {
    key: "likely_excerpts",
    label: "Likely Excerpts / Samples",
    description: "Low-page pending Book records that look like excerpts or sampler entries.",
  },
  {
    key: "comic_issues",
    label: "Likely Comic Books",
    description: "Comic book issues detected by title pattern (e.g., Punisher #12, Batman #45).",
  },
  {
    key: "anthologies",
    label: "Anthologies (5+ Authors)",
    description: "Books with 5 or more primary authors, typically anthologies or short story collections.",
  },
];

const EMPTY_SCAN_SOURCE = {
  lookups_attempted: 0,
  matched: 0,
  failed: 0,
  cached: 0,
  deferred: 0,
  failure_reasons: {},
};

type SettingsSection = "api-keys" | "profiles" | "metadata-refreshes" | "integrations" | "audiobookshelf";

const SECTION_META: Record<SettingsSection, { title: string; description: string }> = {
  "api-keys": {
    title: "API Keys",
    description: "Configure the external services used for metadata enrichment.",
  },
  profiles: {
    title: "Profiles",
    description: "Control what kinds of books appear in the library and review the current library profile.",
  },
  "metadata-refreshes": {
    title: "Metadata Refreshes",
    description: "Run scans, manage refresh cadence, and reset metadata state when needed.",
  },
  integrations: {
    title: "Integrations",
    description: "Configure connections to external services like Audiobookshelf and IRC.",
  },
  audiobookshelf: {
    title: "Audiobookshelf",
    description: "Connect to Audiobookshelf to sync author images, book covers, and metadata.",
  },
};

export default function SettingsPage({ section }: { section: SettingsSection }) {
  const { data: settings } = useSettings();
  const { data: ircSettings } = useIrcSettings();
  const updateSettings = useUpdateSettings();
  const triggerScan = useTriggerScan();
  const resetData = useResetData();
  const [apiKey, setApiKey] = useState("");
  const [googleKey, setGoogleKey] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [showGoogleKey, setShowGoogleKey] = useState(false);
  const [saved, setSaved] = useState(false);
  const [googleSaved, setGoogleSaved] = useState(false);
  const [scanInterval, setScanInterval] = useState("24");
  const [intervalSaved, setIntervalSaved] = useState(false);
  const [persistedScanSummary, setPersistedScanSummary] = useState<ScanSummary | null>(() => {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem("booksarr:lastScanSummary");
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ScanSummary;
    } catch {
      return null;
    }
  });
  const [visibilityCategories, setVisibilityCategories] = useState<VisibilityCategories | null>(null);
  const [visibilitySaved, setVisibilitySaved] = useState(false);
  const [absUrl, setAbsUrl] = useState("");
  const [absApiKey, setAbsApiKey] = useState("");
  const [showAbsKey, setShowAbsKey] = useState(false);
  const [absSaved, setAbsSaved] = useState(false);
  const [absEnabled, setAbsEnabled] = useState(false);
  const [absLibraryId, setAbsLibraryId] = useState("");
  const [preferAbsMetadata, setPreferAbsMetadata] = useState(false);
  const [openOwnedInAbs, setOpenOwnedInAbs] = useState(false);
  const [absTestResult, setAbsTestResult] = useState<{
    success: boolean;
    message: string;
    server_version: string | null;
    libraries: Array<{ id: string; name: string; mediaType: string }>;
  } | null>(null);
  const [absTestLoading, setAbsTestLoading] = useState(false);
  const [absSyncing, setAbsSyncing] = useState(false);
  const queryClient = useQueryClient();

  const syncAuthorImages = useAbsSyncAuthorImages();
  const { data: absSyncStatus } = useAbsSyncStatus(absSyncing);

  const { data: scanStatus } = useScanStatus(true);
  const isScanning = scanStatus?.status === "scanning";
  const { data: apiUsage } = useApiUsage(7, true);
  const wasScanningRef = useRef(false);

  useEffect(() => {
    if (settings?.scan_interval_hours !== undefined) {
      setScanInterval(String(settings.scan_interval_hours));
    }
  }, [settings?.scan_interval_hours]);

  useEffect(() => {
    if (settings?.visibility_categories) {
      setVisibilityCategories(settings.visibility_categories);
    }
  }, [settings?.visibility_categories]);

  useEffect(() => {
    if (settings) {
      setAbsEnabled(settings.abs_enabled ?? false);
      setAbsLibraryId(settings.abs_library_id ?? "");
      setPreferAbsMetadata(settings.prefer_abs_metadata ?? false);
      setOpenOwnedInAbs(settings.open_owned_in_abs ?? false);
    }
  }, [settings]);

  // Auto-test ABS connection when section opens and ABS is configured
  useEffect(() => {
    if (
      section === "audiobookshelf" &&
      settings?.abs_enabled &&
      settings?.abs_url &&
      !absTestResult &&
      !absTestLoading
    ) {
      // Trigger auto-test
      const autoTest = async () => {
        setAbsTestLoading(true);
        try {
          const response = await fetch("/api/abs/test-connection", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          });
          const result = await response.json();
          setAbsTestResult(result);
          if (result.success && result.libraries?.length === 1 && !absLibraryId) {
            setAbsLibraryId(result.libraries[0].id);
          }
        } catch {
          setAbsTestResult({ success: false, message: "Connection test failed", server_version: null, libraries: [] });
        } finally {
          setAbsTestLoading(false);
        }
      };
      autoTest();
    }
  }, [section, settings?.abs_enabled, settings?.abs_url, absTestResult, absTestLoading, absLibraryId]);

  useEffect(() => {
    if (!settings?.last_scan_summary || typeof window === "undefined") return;
    setPersistedScanSummary(settings.last_scan_summary);
    window.localStorage.setItem(
      "booksarr:lastScanSummary",
      JSON.stringify(settings.last_scan_summary),
    );
  }, [settings?.last_scan_summary]);

  useEffect(() => {
    if (!settings || typeof window === "undefined") return;
    if (settings.last_scan_summary || settings.last_scan_at) return;
    setPersistedScanSummary(null);
    window.localStorage.removeItem("booksarr:lastScanSummary");
  }, [settings]);

  useEffect(() => {
    if (isScanning) {
      wasScanningRef.current = true;
      return;
    }

    if (wasScanningRef.current && scanStatus?.status === "idle") {
      wasScanningRef.current = false;
      queryClient.invalidateQueries({ queryKey: ["authors"] });
      queryClient.invalidateQueries({ queryKey: ["books"] });
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    }
  }, [isScanning, queryClient, scanStatus]);

  const handleSaveKey = async () => {
    if (!apiKey.trim()) return;
    await updateSettings.mutateAsync({ hardcover_api_key: apiKey });
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  const handleSaveGoogleKey = async () => {
    if (!googleKey.trim()) return;
    await updateSettings.mutateAsync({ google_books_api_key: googleKey });
    setGoogleSaved(true);
    setTimeout(() => setGoogleSaved(false), 3000);
  };

  const handleSaveInterval = async () => {
    const hours = parseInt(scanInterval, 10);
    if (isNaN(hours) || hours < 0) return;
    await updateSettings.mutateAsync({ scan_interval_hours: hours });
    setIntervalSaved(true);
    setTimeout(() => setIntervalSaved(false), 3000);
  };

  const handleSaveVisibility = async () => {
    if (!visibilityCategories) return;
    await updateSettings.mutateAsync({ visibility_categories: visibilityCategories });
    setVisibilitySaved(true);
    setTimeout(() => setVisibilitySaved(false), 3000);
  };

  const handleSaveAbsSettings = async () => {
    const updates: {
      abs_enabled?: boolean;
      abs_url?: string;
      abs_api_key?: string;
      abs_library_id?: string;
      prefer_abs_metadata?: boolean;
      open_owned_in_abs?: boolean;
    } = {
      abs_enabled: absEnabled,
      prefer_abs_metadata: preferAbsMetadata,
      open_owned_in_abs: openOwnedInAbs,
    };
    if (absUrl.trim()) updates.abs_url = absUrl;
    if (absApiKey.trim()) updates.abs_api_key = absApiKey;
    if (absLibraryId) updates.abs_library_id = absLibraryId;
    await updateSettings.mutateAsync(updates);
    setAbsSaved(true);
    setAbsUrl("");
    setAbsApiKey("");
    setTimeout(() => setAbsSaved(false), 3000);
  };

  const handleAbsTestConnection = async () => {
    setAbsTestLoading(true);
    setAbsTestResult(null);
    try {
      const testUrl = absUrl.trim() || settings?.abs_url || "";
      const testKey = absApiKey.trim() || undefined;
      const response = await fetch("/api/abs/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: testUrl || undefined, api_key: testKey }),
      });
      const result = await response.json();
      setAbsTestResult(result);
      if (result.success && result.libraries?.length === 1 && !absLibraryId) {
        setAbsLibraryId(result.libraries[0].id);
      }
    } catch {
      setAbsTestResult({ success: false, message: "Connection test failed", server_version: null, libraries: [] });
    } finally {
      setAbsTestLoading(false);
    }
  };

  const handleScan = async (force?: boolean) => {
    await triggerScan.mutateAsync(force);
    queryClient.invalidateQueries({ queryKey: ["scanStatus"] });
  };

  const parsedInterval = parseInt(scanInterval, 10);
  const intervalChanged = !isNaN(parsedInterval) && parsedInterval >= 0 && parsedInterval !== (settings?.scan_interval_hours ?? 24);
  const visibilityChanged = JSON.stringify(visibilityCategories) !== JSON.stringify(settings?.visibility_categories ?? null);
  const lastScanSummary = settings?.last_scan_summary ?? persistedScanSummary;
  const formatUsageDay = (day: string) => {
    const [year, month, date] = day.split("-");
    return `${parseInt(month, 10)}/${parseInt(date, 10)}/${year.slice(2)}`;
  };
  const parseApiDate = (value: string | null | undefined) => {
    if (!value) return null;
    const normalized = /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}Z`;
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  const formatApiDateTime = (value: string | null | undefined, fallback: string) =>
    parseApiDate(value)?.toLocaleString() ?? fallback;
  const formatSummaryReason = (value: string) =>
    value
      .split("_")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  const sectionMeta = SECTION_META[section];

  return (
    <div className="max-w-2xl">
      <h2 className="text-2xl font-bold mb-1">Settings</h2>
      <div className="mb-6">
        <h3 className="text-lg font-semibold">{sectionMeta.title}</h3>
        <p className="text-sm text-slate-400">{sectionMeta.description}</p>
      </div>

      {section === "api-keys" && (
        <>

      {/* Hardcover API Key */}
      <div className="bg-slate-800 rounded-lg border border-slate-700 p-6 mb-6">
        <h3 className="text-lg font-semibold mb-4">Hardcover API Key</h3>
        <p className="text-sm text-slate-400 mb-4">
          Get your API key from your{" "}
          <a href="https://hardcover.app/account/api" target="_blank" rel="noopener noreferrer" className="text-emerald-400 hover:underline">
            Hardcover account settings
          </a>.
        </p>
        {settings?.hardcover_api_key && (
          <p className="text-sm text-slate-400 mb-3">
            Current key: <code className="text-slate-300">{settings.hardcover_api_key}</code>
            {settings.hardcover_api_key_source === "environment" && (
              <span className="ml-2 text-xs bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded">ENV</span>
            )}
            {settings.hardcover_api_key_source === "database" && (
              <span className="ml-2 text-xs bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded">OVERRIDE</span>
            )}
          </p>
        )}
        {settings?.hardcover_api_key_from_env && (
          <p className="text-xs text-slate-500 mb-3">
            <code>HARDCOVER_API_KEY</code> is set in the environment. A saved key here will override that fallback.
          </p>
        )}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Enter new API key..."
              className="w-full bg-slate-700 border border-slate-600 text-slate-200 text-sm rounded-lg px-4 py-2 pr-10"
            />
            <button
              onClick={() => setShowKey(!showKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                {showKey ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878L21 21" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                )}
              </svg>
            </button>
          </div>
          <button
            onClick={handleSaveKey}
            disabled={!apiKey.trim()}
            className="bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-600 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            Save
          </button>
        </div>
        {saved && <p className="text-emerald-400 text-sm mt-2">API key saved!</p>}
      </div>

      {/* Google Books API Key */}
      <div className="bg-slate-800 rounded-lg border border-slate-700 p-6 mb-6">
        <div className="flex items-center gap-2 mb-4">
          <h3 className="text-lg font-semibold">Google Books API Key</h3>
          <span className="text-xs bg-slate-600 text-slate-300 px-2 py-0.5 rounded">Optional</span>
        </div>
        <p className="text-sm text-slate-400 mb-2">
          Recommended for stronger Google Books matching, ISBN enrichment, and cover-art fallback. Free — allows 1,000 requests/day.
        </p>
        <ol className="text-sm text-slate-400 mb-4 list-decimal list-inside space-y-1">
          <li>Go to the{" "}
            <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer" className="text-emerald-400 hover:underline">
              Google Cloud Console
            </a>
          </li>
          <li>Create a project (or select an existing one)</li>
          <li>Enable the{" "}
            <a href="https://console.cloud.google.com/apis/library/books.googleapis.com" target="_blank" rel="noopener noreferrer" className="text-emerald-400 hover:underline">
              Books API
            </a>
          </li>
          <li>Go to Credentials and create an API key</li>
        </ol>
        {settings?.google_books_api_key && (
          <p className="text-sm text-slate-400 mb-3">
            Current key: <code className="text-slate-300">{settings.google_books_api_key}</code>
            {settings.google_books_api_key_source === "environment" && (
              <span className="ml-2 text-xs bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded">ENV</span>
            )}
            {settings.google_books_api_key_source === "database" && (
              <span className="ml-2 text-xs bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded">OVERRIDE</span>
            )}
          </p>
        )}
        {settings?.google_books_api_key_from_env && (
          <p className="text-xs text-slate-500 mb-3">
            <code>GOOGLE_BOOKS_API_KEY</code> is set in the environment. A saved key here will override that fallback.
          </p>
        )}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              type={showGoogleKey ? "text" : "password"}
              value={googleKey}
              onChange={(e) => setGoogleKey(e.target.value)}
              placeholder="Enter Google Books API key..."
              className="w-full bg-slate-700 border border-slate-600 text-slate-200 text-sm rounded-lg px-4 py-2 pr-10"
            />
            <button
              onClick={() => setShowGoogleKey(!showGoogleKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                {showGoogleKey ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878L21 21" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                )}
              </svg>
            </button>
          </div>
          <button
            onClick={handleSaveGoogleKey}
            disabled={!googleKey.trim()}
            className="bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-600 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            Save
          </button>
        </div>
        {googleSaved && <p className="text-emerald-400 text-sm mt-2">API key saved!</p>}
      </div>

      {/* API Usage */}
      <div className="bg-slate-800 rounded-lg border border-slate-700 p-6 mb-6">
        <h3 className="text-lg font-semibold mb-4">API Calls</h3>
        <p className="text-sm text-slate-400 mb-4">
          Daily outbound API call totals by source for the last 7 days.
        </p>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm border-collapse">
            <thead>
              <tr className="bg-slate-700/60 text-slate-200">
                <th className="border border-slate-600 px-3 py-2 text-left">API Calls</th>
                <th className="border border-slate-600 px-3 py-2 text-right">Total</th>
                <th className="border border-slate-600 px-3 py-2 text-right">Hard Cover</th>
                <th className="border border-slate-600 px-3 py-2 text-right">Google</th>
                <th className="border border-slate-600 px-3 py-2 text-right">Open Library</th>
                <th className="border border-slate-600 px-3 py-2 text-right">Wikimedia</th>
              </tr>
            </thead>
            <tbody>
              {(apiUsage ?? []).map((row) => (
                <tr key={row.day} className="text-slate-300 odd:bg-slate-800 even:bg-slate-800/50">
                  <td className="border border-slate-700 px-3 py-2">{formatUsageDay(row.day)}</td>
                  <td className="border border-slate-700 px-3 py-2 text-right">{row.total}</td>
                  <td className="border border-slate-700 px-3 py-2 text-right">{row.hardcover}</td>
                  <td className="border border-slate-700 px-3 py-2 text-right">{row.google}</td>
                  <td className="border border-slate-700 px-3 py-2 text-right">{row.openlibrary}</td>
                  <td className="border border-slate-700 px-3 py-2 text-right">{row.wikimedia}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
        </>
      )}

      {section === "profiles" && (
        <>

        {/* Visibility */}
        <div className="bg-slate-800 rounded-lg border border-slate-700 p-6 mb-6">
          <h3 className="text-lg font-semibold mb-4">Book Visibility</h3>
          <p className="text-sm text-slate-400 mb-2">
            Choose which types of books should be included in the library by default.
          </p>
          <p className="text-xs text-slate-500 mb-4">
            Owned books are always shown. Books hidden by these rules are skipped for Google Books and Open Library lookups to conserve external API usage, except titles hidden only for missing valid ISBNs still get checked so external ISBN matches can unhide them.
          </p>
          <div className="space-y-3">
            {VISIBILITY_OPTIONS.map((option) => (
              <label
                key={option.key}
                className="flex items-start gap-3 rounded-lg border border-slate-700 bg-slate-900/30 px-4 py-3"
              >
                <input
                  type="checkbox"
                  checked={visibilityCategories?.[option.key] ?? false}
                  onChange={(e) =>
                    setVisibilityCategories((current) =>
                      current
                        ? { ...current, [option.key]: e.target.checked }
                        : current
                    )
                  }
                  className="mt-1 h-4 w-4 rounded border-slate-500 bg-slate-700 text-emerald-500 focus:ring-emerald-500"
                />
                <div>
                  <div className="text-sm font-medium text-slate-200">{option.label}</div>
                  <div className="text-xs text-slate-400 mt-1">{option.description}</div>
                </div>
              </label>
            ))}
          </div>
          <div className="flex items-center gap-3 mt-4">
            <button
              onClick={handleSaveVisibility}
              disabled={!visibilityChanged || !visibilityCategories}
              className="bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-600 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
            >
              Save
            </button>
            {visibilitySaved && <span className="text-emerald-400 text-sm">Visibility rules updated!</span>}
          </div>
          <div className="mt-4 pt-4 border-t border-slate-700">
            <Link
              to="/books/hidden"
              className="inline-flex items-center gap-2 bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm font-medium px-4 py-2 rounded-lg transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12H9m12 0A9 9 0 113 12a9 9 0 0118 0z" />
              </svg>
              View Hidden Books
            </Link>
          </div>
        </div>

        {lastScanSummary?.hidden_by_category.length ? (
          <div className="bg-slate-800 rounded-lg border border-slate-700 p-6 mb-6">
            <div className="text-sm font-medium text-slate-200 mb-3">Hidden By Category</div>
            <div className="flex flex-wrap gap-2">
              {lastScanSummary.hidden_by_category.map((item) => (
                <span
                  key={item.key}
                  className="rounded-full border border-slate-700 bg-slate-900/40 px-3 py-1 text-xs text-slate-300"
                >
                  {item.label}: {item.count}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {/* Library Info */}
        <div className="bg-slate-800 rounded-lg border border-slate-700 p-6 mb-6">
          <h3 className="text-lg font-semibold mb-4">Library</h3>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-400">Library Path</span>
              <code className="text-slate-300">{settings?.library_path || "-"}</code>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Last Scan</span>
              <span className="text-slate-300">
                {settings?.last_scan_at
                  ? formatApiDateTime(settings.last_scan_at, "Never")
                  : "Never"}
              </span>
            </div>
          </div>
        </div>
        </>
      )}

      {section === "metadata-refreshes" && (
        <>

        {/* Scan Controls */}
        <div className="bg-slate-800 rounded-lg border border-slate-700 p-6 mb-6">
        <h3 className="text-lg font-semibold mb-4">Library Scan</h3>
        <p className="text-sm text-slate-400 mb-4">
          Scan your library folder for new books, match to Hardcover, and download metadata and covers.
          Only new and removed files are processed — existing books are untouched.
        </p>

        <p className="text-xs text-slate-500 mb-4">
          Live scan status refreshes automatically every second while this page is open.
        </p>

        {isScanning && scanStatus && (
          <div className="mb-4">
            <div className="flex justify-between text-sm mb-1">
              <span className="text-slate-300">{scanStatus.message}</span>
              <span className="text-emerald-400">{Math.round(scanStatus.progress)}%</span>
            </div>
            <div className="w-full bg-slate-700 rounded-full h-2">
              <div
                className="bg-emerald-500 h-2 rounded-full transition-all duration-500"
                style={{ width: `${scanStatus.progress}%` }}
              />
            </div>
          </div>
        )}

        <div className="flex gap-3 mb-4">
          <button
            onClick={() => handleScan()}
            disabled={isScanning}
            className="bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-600 disabled:cursor-not-allowed text-white font-medium px-6 py-2 rounded-lg transition-colors"
          >
            {isScanning ? "Scanning..." : "Scan Library"}
          </button>
          <button
            onClick={() => handleScan(true)}
            disabled={isScanning}
            className="bg-slate-600 hover:bg-slate-500 disabled:bg-slate-700 disabled:cursor-not-allowed text-white font-medium px-6 py-2 rounded-lg transition-colors"
          >
            Full Refresh
          </button>
        </div>
        <p className="text-xs text-slate-500">
          Scan Library detects new/removed files and only fetches metadata for changes. Full Refresh re-fetches all data from Hardcover.
        </p>

        {lastScanSummary && (
          <div className="mt-6 border-t border-slate-700 pt-6">
            <div className="flex flex-col gap-1 mb-4">
              <h4 className="text-base font-semibold text-slate-100">Last Run Summary</h4>
              <p className="text-sm text-slate-400">
                {lastScanSummary.completed_at
                  ? `Completed ${formatApiDateTime(lastScanSummary.completed_at, "recently")}`
                  : "Most recent completed scan"}
                {" · "}
                {lastScanSummary.mode === "full_refresh" ? "Full Refresh" : "Scan Library"}
                {" · "}
                <span className={lastScanSummary.status === "error" ? "text-red-400" : "text-emerald-400"}>
                  {lastScanSummary.status === "error" ? "Failed" : "Completed"}
                </span>
              </p>
              {lastScanSummary.message && (
                <p className="text-xs text-slate-500">{lastScanSummary.message}</p>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4 mb-4">
              <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
                <div className="text-xs uppercase tracking-wide text-slate-500">Owned Books Found Locally</div>
                <div className="mt-1 text-2xl font-semibold text-slate-100">{lastScanSummary.owned_books_found}</div>
              </div>
              <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
                <div className="text-xs uppercase tracking-wide text-slate-500">Authors Added</div>
                <div className="mt-1 text-2xl font-semibold text-slate-100">{lastScanSummary.authors_added}</div>
              </div>
              <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
                <div className="text-xs uppercase tracking-wide text-slate-500">Books Added</div>
                <div className="mt-1 text-2xl font-semibold text-slate-100">{lastScanSummary.books_added}</div>
              </div>
              <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4">
                <div className="text-xs uppercase tracking-wide text-slate-500">Books Hidden</div>
                <div className="mt-1 text-2xl font-semibold text-slate-100">{lastScanSummary.books_hidden}</div>
              </div>
            </div>

            <div className="rounded-lg border border-slate-700 bg-slate-900/30 px-4 py-3 mb-4 text-sm text-slate-300">
              Files processed: {lastScanSummary.files_total} total, {lastScanSummary.files_new} new, {lastScanSummary.files_deleted} deleted, {lastScanSummary.files_unchanged} unchanged.
            </div>

            {(lastScanSummary.new_books_list?.length > 0 || lastScanSummary.isbn_gains > 0) && (
              <div className="grid gap-4 sm:grid-cols-2 mb-4">
                {lastScanSummary.new_books_list?.length > 0 && (
                  <div className="rounded-lg border border-slate-700 bg-slate-900/30 px-4 py-3">
                    <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">
                      New Books Added ({lastScanSummary.new_books_list.length}{lastScanSummary.books_added > lastScanSummary.new_books_list.length ? "+" : ""})
                    </div>
                    <div className="space-y-0.5 max-h-48 overflow-y-auto">
                      {lastScanSummary.new_books_list.map((b, i) => (
                        <div key={i} className="flex items-baseline gap-1.5 text-xs">
                          <span className="text-slate-300 truncate">{b.title}</span>
                          <span className="shrink-0 text-slate-600">—</span>
                          <span className="shrink-0 text-slate-500">{b.author}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {lastScanSummary.isbn_gains > 0 && (
                  <div className="rounded-lg border border-slate-700 bg-slate-900/30 px-4 py-3">
                    <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">ISBN Gains</div>
                    <div className="text-2xl font-semibold text-emerald-400">{lastScanSummary.isbn_gains}</div>
                    <div className="text-xs text-slate-500 mt-1">books gained a valid ISBN this scan</div>
                  </div>
                )}
              </div>
            )}

            <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
                {[
                { key: "hardcover", label: "Hardcover", summary: lastScanSummary.hardcover ?? EMPTY_SCAN_SOURCE },
                { key: "google", label: "Google Books", summary: lastScanSummary.google ?? EMPTY_SCAN_SOURCE },
                { key: "openlibrary", label: "Open Library", summary: lastScanSummary.openlibrary ?? EMPTY_SCAN_SOURCE },
                { key: "wikimedia", label: "Wikimedia", summary: lastScanSummary.wikimedia ?? EMPTY_SCAN_SOURCE },
              ].map((source) => (
                <div key={source.key} className="rounded-lg border border-slate-700 bg-slate-900/30 p-4">
                  <div className="text-sm font-semibold text-slate-100 mb-3">{source.label}</div>
                  <div className="grid grid-cols-2 gap-3 text-sm mb-3">
                    <div>
                      <div className="text-slate-500">Lookups</div>
                      <div className="text-slate-200">{source.summary.lookups_attempted}</div>
                    </div>
                    <div>
                      <div className="text-slate-500">Matched</div>
                      <div className="text-slate-200">{source.summary.matched}</div>
                    </div>
                    <div>
                      <div className="text-slate-500">Failed</div>
                      <div className="text-slate-200">{source.summary.failed}</div>
                    </div>
                    <div>
                      <div className="text-slate-500">Cached</div>
                      <div className="text-slate-200">{source.summary.cached}</div>
                    </div>
                    <div>
                      <div className="text-slate-500">Deferred</div>
                      <div className="text-slate-200">{source.summary.deferred}</div>
                    </div>
                  </div>
                  {Object.keys(source.summary.failure_reasons).length > 0 ? (
                    <div className="border-t border-slate-700 pt-3">
                      <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">Failure Reasons</div>
                      <div className="space-y-1 text-sm">
                        {Object.entries(source.summary.failure_reasons).map(([reason, count]) => (
                          <div key={reason} className="flex justify-between gap-3 text-slate-300">
                            <span>{formatSummaryReason(reason)}</span>
                            <span>{count}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="border-t border-slate-700 pt-3 text-sm text-slate-500">No failures recorded in this run.</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Scheduled Scan */}
      <div className="bg-slate-800 rounded-lg border border-slate-700 p-6 mb-6">
        <h3 className="text-lg font-semibold mb-4">Scheduled Scan</h3>
        <p className="text-sm text-slate-400 mb-4">
          Automatically scan your library for changes on a schedule. Set to 0 to disable.
        </p>
        <div className="flex gap-2 items-center">
          <input
            type="number"
            min="0"
            value={scanInterval}
            onChange={(e) => setScanInterval(e.target.value)}
            className="w-24 bg-slate-700 border border-slate-600 text-slate-200 text-sm rounded-lg px-4 py-2"
          />
          <span className="text-sm text-slate-400">hours</span>
          <button
            onClick={handleSaveInterval}
            disabled={!intervalChanged}
            className="bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-600 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            Save
          </button>
          {intervalSaved && <span className="text-emerald-400 text-sm">Schedule updated!</span>}
        </div>
        {(settings?.scan_interval_hours ?? 24) > 0 && (
          <p className="text-xs text-emerald-400 mt-2">
            Active: scanning every {settings?.scan_interval_hours ?? 24} hour(s)
          </p>
        )}
      </div>

      {/* Reset */}
      <div className="bg-slate-800 rounded-lg border border-red-900/50 p-6">
        <h3 className="text-lg font-semibold text-red-400 mb-2">Danger Zone</h3>
        <p className="text-sm text-slate-400 mb-4">
          Delete all database data and cached images. This resets the application to a fresh install. Your ebook files are not affected.
        </p>
        {!confirmReset ? (
          <button
            onClick={() => setConfirmReset(true)}
            className="bg-red-600 hover:bg-red-500 text-white font-medium px-6 py-2 rounded-lg transition-colors"
          >
            Reset All Data
          </button>
        ) : (
          <div className="flex items-center gap-3">
            <button
              onClick={async () => {
                await resetData.mutateAsync();
                setConfirmReset(false);
              }}
              disabled={resetData.isPending}
              className="bg-red-600 hover:bg-red-500 disabled:bg-red-800 text-white font-medium px-6 py-2 rounded-lg transition-colors"
            >
              {resetData.isPending ? "Resetting..." : "Yes, delete everything"}
            </button>
            <button
              onClick={() => setConfirmReset(false)}
              className="bg-slate-600 hover:bg-slate-500 text-white font-medium px-6 py-2 rounded-lg transition-colors"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
        </>
      )}

      {section === "integrations" && (
        <>
          <div className="bg-slate-800 rounded-lg border border-slate-700 p-6 mb-6">
            <h3 className="text-lg font-semibold mb-2">External Services</h3>
            <p className="text-sm text-slate-400 mb-6">
              Connect Booksarr to external services for enhanced functionality.
            </p>
            <div className="grid gap-4 md:grid-cols-2">
              <a
                href="/settings/audiobookshelf"
                className="block rounded-lg border border-slate-600 bg-slate-700/50 p-4 hover:bg-slate-700 transition-colors"
              >
                <div className="flex items-center gap-3 mb-2">
                  <div className={`w-2 h-2 rounded-full ${settings?.abs_enabled ? "bg-emerald-400" : "bg-slate-500"}`} />
                  <h4 className="font-medium text-slate-200">Audiobookshelf</h4>
                </div>
                <p className="text-sm text-slate-400">
                  Sync author images, book covers, and enable direct links to your library.
                </p>
              </a>
              <a
                href="/settings/irc"
                className="block rounded-lg border border-slate-600 bg-slate-700/50 p-4 hover:bg-slate-700 transition-colors"
              >
                <div className="flex items-center gap-3 mb-2">
                  <div className={`w-2 h-2 rounded-full ${ircSettings?.enabled ? "bg-emerald-400" : "bg-slate-500"}`} />
                  <h4 className="font-medium text-slate-200">IRC</h4>
                </div>
                <p className="text-sm text-slate-400">
                  Search and download books via IRC DCC transfers.
                </p>
              </a>
            </div>
          </div>
        </>
      )}

      {section === "audiobookshelf" && (
        <>
      {/* ABS Connection */}
      <div className="bg-slate-800 rounded-lg border border-slate-700 p-6 mb-6">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h3 className="text-lg font-semibold mb-2">Connection</h3>
            <p className="text-sm text-slate-400">
              Connect to your Audiobookshelf instance to sync data and enable "Open in Audiobookshelf" links.
            </p>
          </div>
          <div className="text-right">
            {!settings?.abs_enabled ? (
              <>
                <div className="text-sm font-medium text-amber-400">disabled</div>
                <div className="text-xs text-slate-500 mt-1">ABS integration disabled in settings</div>
              </>
            ) : absTestLoading ? (
              <div className="text-sm font-medium text-amber-400">checking...</div>
            ) : absTestResult ? (
              <>
                <div className={`text-sm font-medium ${absTestResult.success ? "text-emerald-400" : "text-red-400"}`}>
                  {absTestResult.success ? "connected" : "error"}
                </div>
                <div className="text-xs text-slate-500 mt-1">{absTestResult.message}</div>
                {absTestResult.success && absTestResult.libraries && (
                  <div className="text-xs text-slate-400 mt-1">
                    {absTestResult.libraries.length} {absTestResult.libraries.length === 1 ? "library" : "libraries"} available
                  </div>
                )}
              </>
            ) : settings?.abs_url ? (
              <div className="text-xs text-slate-500">Click "Test Connection" to verify</div>
            ) : (
              <div className="text-xs text-slate-500">Configure URL to connect</div>
            )}
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2 mt-6">
          <label className="flex items-center gap-3 text-sm text-slate-200 md:col-span-2">
            <input
              type="checkbox"
              checked={absEnabled}
              onChange={(e) => setAbsEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-slate-500 bg-slate-700 text-emerald-500 focus:ring-emerald-500"
            />
            Enable Audiobookshelf integration
          </label>

          <div>
            <div className="text-xs text-slate-400 mb-1">Server URL</div>
            {settings?.abs_url && (
              <div className="text-xs text-slate-500 mb-1">
                Current: {settings.abs_url}
                {settings.abs_url_source === "environment" && (
                  <span className="ml-1 text-blue-400">(ENV)</span>
                )}
              </div>
            )}
            <input
              value={absUrl}
              onChange={(e) => setAbsUrl(e.target.value)}
              placeholder={settings?.abs_url || "http://audiobookshelf:80"}
              className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-sm text-slate-200"
            />
          </div>

          <div>
            <div className="text-xs text-slate-400 mb-1">API Token</div>
            {settings?.abs_api_key && (
              <div className="text-xs text-slate-500 mb-1">
                Current: {settings.abs_api_key}
                {settings.abs_api_key_source === "environment" && (
                  <span className="ml-1 text-blue-400">(ENV)</span>
                )}
              </div>
            )}
            <div className="relative">
              <input
                type={showAbsKey ? "text" : "password"}
                value={absApiKey}
                onChange={(e) => setAbsApiKey(e.target.value)}
                placeholder="Enter new API token to update..."
                className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 pr-10 text-sm text-slate-200"
              />
              <button
                onClick={() => setShowAbsKey(!showAbsKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  {showAbsKey ? (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878L21 21" />
                  ) : (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  )}
                </svg>
              </button>
            </div>
          </div>

          <div className="md:col-span-2">
            <div className="text-xs text-slate-400 mb-1">Library</div>
            {!settings?.abs_enabled ? (
              <div className="text-sm text-slate-500">Enable ABS integration to configure library</div>
            ) : absTestResult?.libraries && absTestResult.libraries.length > 0 ? (
              <select
                value={absLibraryId}
                onChange={(e) => setAbsLibraryId(e.target.value)}
                className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-sm text-slate-200"
              >
                <option value="">Select a library...</option>
                {absTestResult.libraries.map((lib) => (
                  <option key={lib.id} value={lib.id}>
                    {lib.name}
                  </option>
                ))}
              </select>
            ) : (
              <div className="text-sm text-slate-500">
                {settings?.abs_library_id ? (
                  <>
                    Current: <code className="text-slate-400">{settings.abs_library_id}</code>
                    <span className="ml-2">(test connection to see library name)</span>
                  </>
                ) : (
                  "Test connection to see available libraries"
                )}
              </div>
            )}
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button
            onClick={handleSaveAbsSettings}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500"
          >
            Save
          </button>
          <button
            onClick={handleAbsTestConnection}
            disabled={absTestLoading || (!settings?.abs_url && !absUrl.trim())}
            className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {absTestLoading ? "Testing..." : "Test Connection"}
          </button>
          {absSaved && <span className="text-sm text-emerald-400">Settings saved!</span>}
        </div>
      </div>

      {/* Metadata Preferences */}
      <div className="bg-slate-800 rounded-lg border border-slate-700 p-6 mb-6">
        <h3 className="text-lg font-semibold mb-2">Metadata Preferences</h3>
        <p className="text-sm text-slate-400 mb-4">
          Control how Audiobookshelf metadata is used when enriching your library.
        </p>

        <label className="flex items-center gap-3 text-sm text-slate-200">
          <input
            type="checkbox"
            checked={preferAbsMetadata}
            onChange={(e) => setPreferAbsMetadata(e.target.checked)}
            className="h-4 w-4 rounded border-slate-500 bg-slate-700 text-emerald-500 focus:ring-emerald-500"
          />
          Prefer Audiobookshelf metadata
        </label>
        <p className="text-xs text-slate-500 mt-2 ml-7">
          When enabled, author images and book covers from ABS take priority over Hardcover.
          When disabled, ABS data only fills gaps where Hardcover data is missing.
        </p>

        <label className="flex items-center gap-3 text-sm text-slate-200 mt-4">
          <input
            type="checkbox"
            checked={openOwnedInAbs}
            onChange={(e) => setOpenOwnedInAbs(e.target.checked)}
            className="h-4 w-4 rounded border-slate-500 bg-slate-700 text-emerald-500 focus:ring-emerald-500"
          />
          Open library items in Audiobookshelf
        </label>
        <p className="text-xs text-slate-500 mt-2 ml-7">
          When enabled, clicking owned books or authors with books in your library opens Audiobookshelf instead of Hardcover.
        </p>
      </div>

      {/* Sync Actions */}
      <div className="bg-slate-800 rounded-lg border border-slate-700 p-6">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h3 className="text-lg font-semibold mb-2">Sync Actions</h3>
            <p className="text-sm text-slate-400">
              Sync author images and book covers from Audiobookshelf to enrich your library.
            </p>
          </div>
          {absSyncStatus && absSyncStatus.status !== "idle" && (
            <div className="text-right">
              <div className={`text-sm font-medium ${
                absSyncStatus.status === "completed" ? "text-emerald-400" :
                absSyncStatus.status === "failed" ? "text-red-400" :
                "text-amber-400"
              }`}>
                {absSyncStatus.status}
              </div>
              <div className="text-xs text-slate-500 mt-1">{absSyncStatus.message}</div>
              {absSyncStatus.status === "syncing" && (absSyncStatus.total_authors > 0 || absSyncStatus.total_books > 0) && (
                <div className="text-xs text-slate-500">
                  {absSyncStatus.authors_processed} / {absSyncStatus.total_authors} authors, {absSyncStatus.books_processed} / {absSyncStatus.total_books} books
                </div>
              )}
            </div>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            onClick={async () => {
              setAbsSyncing(true);
              try {
                await syncAuthorImages.mutateAsync();
              } finally {
                // Keep polling for a bit to show final status
                setTimeout(() => setAbsSyncing(false), 2000);
              }
            }}
            disabled={!settings?.abs_enabled || !settings?.abs_url || !settings?.abs_api_key || !settings?.abs_library_id || syncAuthorImages.isPending}
            className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed disabled:text-slate-500"
          >
            {syncAuthorImages.isPending ? "Syncing..." : "Sync from Audiobookshelf"}
          </button>
          {absSyncStatus?.status === "completed" && (
            <span className="text-sm text-emerald-400">
              Updated {absSyncStatus.authors_updated} author{absSyncStatus.authors_updated !== 1 ? "s" : ""}, {absSyncStatus.books_updated} book{absSyncStatus.books_updated !== 1 ? "s" : ""}
            </span>
          )}
        </div>

        {(!settings?.abs_enabled || !settings?.abs_url || !settings?.abs_api_key) && (
          <p className="text-xs text-slate-500 mt-3">
            Enable integration and configure connection above to use sync actions.
          </p>
        )}
      </div>
        </>
      )}
    </div>
  );
}
