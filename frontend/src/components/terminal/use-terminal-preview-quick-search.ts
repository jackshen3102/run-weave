import { useMemoizedFn } from "ahooks";
import { useEffect, useRef, useState } from "react";
import type { TerminalPreviewContentSearchItem, TerminalPreviewFileSearchItem, TerminalPreviewFolderSearchItem, TerminalPreviewQuickSearchMode } from "@runweave/shared/terminal/preview";
import {
  searchTerminalProjectPreviewContent,
  searchTerminalProjectPreviewFiles,
  searchTerminalProjectPreviewFolders,
} from "../../services/terminal";

const QUICK_SEARCH_DEBOUNCE_MS = 180;
const QUICK_SEARCH_LIMIT = 50;

interface UseTerminalPreviewQuickSearchArgs {
  apiBase: string;
  token: string;
  projectId: string | null;
  onRequestError: (error: unknown) => string;
}

interface QuickSearchResults {
  files: TerminalPreviewFileSearchItem[];
  content: TerminalPreviewContentSearchItem[];
  folders: TerminalPreviewFolderSearchItem[];
}

const EMPTY_RESULTS: QuickSearchResults = {
  files: [],
  content: [],
  folders: [],
};

export function useTerminalPreviewQuickSearch({
  apiBase,
  token,
  projectId,
  onRequestError,
}: UseTerminalPreviewQuickSearchArgs) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<TerminalPreviewQuickSearchMode>("files");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<QuickSearchResults>(EMPTY_RESULTS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const requestIdRef = useRef(0);

  const openSearch = useMemoizedFn(
    (nextMode: TerminalPreviewQuickSearchMode = "files") => {
      setMode(nextMode);
      setOpen(true);
      setError(null);
    },
  );

  const closeSearch = useMemoizedFn(() => {
    setOpen(false);
  });

  useEffect(() => {
    if (!open || !projectId) {
      setLoading(false);
      setError(null);
      setTruncated(false);
      setResults(EMPTY_RESULTS);
      return;
    }

    const trimmedQuery = query.trim();
    if ((mode === "content" || mode === "folders") && !trimmedQuery) {
      requestIdRef.current += 1;
      setLoading(false);
      setError(null);
      setTruncated(false);
      setResults((current) => ({ ...current, [mode]: [] }));
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const timeoutId = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      const request =
        mode === "files"
          ? searchTerminalProjectPreviewFiles(apiBase, token, projectId, {
              query,
              limit: QUICK_SEARCH_LIMIT,
            }).then((payload) => ({
              items: payload.items,
              truncated: false,
            }))
          : mode === "content"
            ? searchTerminalProjectPreviewContent(apiBase, token, projectId, {
                query,
                limit: QUICK_SEARCH_LIMIT,
              }).then((payload) => ({
                items: payload.items,
                truncated: payload.truncated,
              }))
            : searchTerminalProjectPreviewFolders(apiBase, token, projectId, {
                query,
                limit: QUICK_SEARCH_LIMIT,
              }).then((payload) => ({
                items: payload.items,
                truncated: payload.truncated,
              }));

      request
        .then((payload) => {
          if (requestIdRef.current !== requestId) {
            return;
          }
          setResults((current) => ({ ...current, [mode]: payload.items }));
          setTruncated(payload.truncated);
        })
        .catch((caught: unknown) => {
          if (requestIdRef.current !== requestId) {
            return;
          }
          setResults((current) => ({ ...current, [mode]: [] }));
          setError(onRequestError(caught));
          setTruncated(false);
        })
        .finally(() => {
          if (requestIdRef.current === requestId) {
            setLoading(false);
          }
        });
    }, QUICK_SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [apiBase, mode, onRequestError, open, projectId, query, token]);

  return {
    open,
    mode,
    query,
    results,
    loading,
    error,
    truncated,
    openSearch,
    closeSearch,
    setOpen,
    setMode,
    setQuery,
  };
}
