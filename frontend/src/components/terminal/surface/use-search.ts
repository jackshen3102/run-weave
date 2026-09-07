import { useMemoizedFn } from "ahooks";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";
import type { ClientMode } from "../../../features/client-mode";
import type {
  SearchDirection,
  TerminalSearchOptions,
  TerminalSearchResults,
} from "./surface-utils";

interface UseTerminalSearchOptions {
  active: boolean;
  clientMode: ClientMode;
  terminalRef: RefObject<Terminal | null>;
}

export function useTerminalSearch({
  active,
  clientMode,
  terminalRef,
}: UseTerminalSearchOptions) {
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TerminalSearchResults | null>(null);
  const [options, setOptions] = useState<TerminalSearchOptions>({
    caseSensitive: false,
    wholeWord: false,
    regex: false,
  });

  const clear = useMemoizedFn(() => {
    setResults(null);
    searchAddonRef.current?.clearDecorations();
    searchAddonRef.current?.clearActiveDecoration();
  });

  const run = useMemoizedFn(
    (direction: SearchDirection, nextQuery = query): void => {
      if (!nextQuery) {
        clear();
        return;
      }

      const searchAddon = searchAddonRef.current;
      if (!searchAddon) {
        return;
      }

      if (direction === "previous") {
        searchAddon.findPrevious(nextQuery, options);
        return;
      }

      searchAddon.findNext(nextQuery, options);
    },
  );

  useEffect(() => {
    if (!open) {
      return;
    }

    const frameId = requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
    return () => cancelAnimationFrame(frameId);
  }, [open]);

  useEffect(() => {
    if (!open) {
      clear();
      return;
    }
    run("next");
  }, [clear, open, options, query, run]);

  useEffect(() => {
    if (!active) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        clientMode === "mobile" ||
        event.defaultPrevented ||
        !(target instanceof Node) ||
        !(
          terminalRef.current?.element?.contains(target) ||
          searchInputRef.current?.parentElement?.contains(target)
        )
      ) {
        return;
      }

      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(true);
        return;
      }

      if (event.key === "Escape" && open) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        terminalRef.current?.focus();
      }
    };

    // Handle terminal-local shortcuts before xterm consumes Ctrl+F as PTY input.
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [active, clientMode, open, terminalRef]);

  useEffect(() => {
    if (clientMode === "mobile") {
      setOpen(false);
    }
  }, [clientMode]);

  return {
    addonRef: searchAddonRef,
    inputRef: searchInputRef,
    open,
    options,
    query,
    results,
    run,
    setOpen,
    setOptions,
    setQuery,
    setResults,
  };
}
