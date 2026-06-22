import { useMemoizedFn } from "ahooks";
import { useEffect, useRef, useState } from "react";
import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";
import { scrollTerminalToBottom } from "@runweave/common/terminal";
import type { ClientMode } from "../../features/client-mode";
import {
  logTerminalPerf,
  summarizeTerminalChunk,
} from "../../features/terminal/perf-logging";
import { normalizeTerminalBrowserUrl } from "../../features/terminal/browser-url";
import { useTerminalPreviewStore } from "../../features/terminal/preview-store";
import { useTerminalConnection } from "../../features/terminal/use-terminal-connection";
import { scheduleTerminalViewportRefresh } from "../../features/terminal/viewport-refresh";
import { sendTerminalInput as sendTerminalInputRequest } from "../../services/terminal";
import { TerminalSurfaceLayout } from "./terminal-surface-layout";
import { useTerminalEmulator } from "./use-terminal-emulator";
import { useTerminalOutputStream } from "./use-terminal-output-stream";
import { useTerminalSnapshotRestore } from "./use-terminal-snapshot-restore";
import {
  IME_COMMIT_DUPLICATE_WINDOW_MS,
  IME_COMMIT_WINDOW_MS,
  TERMINAL_RESIZE_DEBOUNCE_MS,
  hasNonAsciiInput,
  type PastedImageReference,
  type SearchDirection,
  type TerminalSearchOptions,
  type TerminalSearchResults,
} from "./terminal-surface-utils";

interface TerminalSurfaceProps {
  active: boolean;
  apiBase: string;
  terminalSessionId: string;
  token: string;
  clientMode?: ClientMode;
  layoutVersion?: string;
  onAuthExpired?: () => void;
  onBell?: () => void;
  onMetadata?: (metadata: {
    cwd: string;
    activeCommand: string | null;
  }) => void;
}

export function TerminalSurface({
  active,
  apiBase,
  terminalSessionId,
  token,
  clientMode = "desktop",
  layoutVersion = "default",
  onAuthExpired,
  onBell,
  onMetadata,
}: TerminalSurfaceProps) {
  const terminalContainerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const createBrowserTab = useTerminalPreviewStore(
    (state) => state.createBrowserTab,
  );
  const openBrowser = useTerminalPreviewStore((state) => state.openBrowser);
  const refreshTerminalViewportRef = useRef<(() => void) | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const activeRef = useRef(active);
  const onBellRef = useRef(onBell);
  const onAuthExpiredRef = useRef(onAuthExpired);
  const openTerminalLinkRef = useRef<(uri: string) => void>(() => undefined);
  const onMetadataRef = useRef(onMetadata);
  const tokenRef = useRef(token);
  const runtimeKindRef = useRef<"tmux" | "pty" | null>(null);
  const lastResizedAtRef = useRef<number | null>(null);
  const inputSequenceRef = useRef(0);
  const outputSequenceRef = useRef(0);
  const xtermUserInputSequenceRef = useRef(0);
  const lastInputSentAtRef = useRef<number | null>(null);
  const lastInputDataRef = useRef<{ data: string; at: number } | null>(null);
  const imeCommitRef = useRef<{ data: string; at: number } | null>(null);
  const imeCompositionEndedAtRef = useRef<number | null>(null);
  const hasDeferredOutputRef = useRef(false);
  const deferredOutputRef = useRef("");
  const requiresSnapshotRestoreRef = useRef(false);
  const hasRenderedSnapshotRef = useRef(false);
  const restoreSnapshotRequestRef = useRef(0);
  const websocketContentVersionRef = useRef(0);
  const lastSentResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [pastedImages, setPastedImages] = useState<PastedImageReference[]>([]);
  const [mobileKeybarOpen, setMobileKeybarOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] =
    useState<TerminalSearchResults | null>(null);
  const [terminalAtBottom, setTerminalAtBottom] = useState(true);
  const [hasNewOutputBelow, setHasNewOutputBelow] = useState(false);
  const [tmuxScrollbackActive, setTmuxScrollbackActive] = useState(false);
  const [searchOptions, setSearchOptions] = useState<TerminalSearchOptions>({
    caseSensitive: false,
    wholeWord: false,
    regex: false,
  });

  const {
    onOutput,
    onSnapshot,
    renderTerminalSnapshot,
    replayDeferredOutput,
  } = useTerminalOutputStream({
    activeRef,
    deferredOutputRef,
    hasDeferredOutputRef,
    hasRenderedSnapshotRef,
    lastInputSentAtRef,
    onBellRef,
    outputSequenceRef,
    refreshTerminalViewportRef,
    requiresSnapshotRestoreRef,
    setHasNewOutputBelow,
    setTerminalAtBottom,
    setTmuxScrollbackActive,
    terminalRef,
    terminalSessionId,
    websocketContentVersionRef,
  });

  const { error, sendInput, sendResize, runtimeKind } = useTerminalConnection({
    apiBase,
    terminalSessionId,
    token,
    onAuthExpired,
    onSnapshot,
    onOutput,
    onMetadata,
  });

  const sendTerminalInput = useMemoizedFn((data: string): void => {
    const now = performance.now();
    const lastInput = lastInputDataRef.current;
    const imeCommit = imeCommitRef.current;
    if (
      lastInput &&
      imeCommit &&
      hasNonAsciiInput(data) &&
      data === lastInput.data &&
      data === imeCommit.data &&
      now - lastInput.at <= IME_COMMIT_DUPLICATE_WINDOW_MS &&
      now - imeCommit.at <= IME_COMMIT_WINDOW_MS
    ) {
      return;
    }

    lastInputDataRef.current = { data, at: now };
    inputSequenceRef.current += 1;
    lastInputSentAtRef.current = Date.now();
    logTerminalPerf("terminal.input.captured", {
      terminalSessionId,
      seq: inputSequenceRef.current,
      ...summarizeTerminalChunk(data),
    });
    sendInput(data);
  });

  const handleBottomStateChange = useMemoizedFn((isAtBottom: boolean) => {
    setTerminalAtBottom(isAtBottom);
    if (isAtBottom) {
      setHasNewOutputBelow(false);
    }
  });

  const requestTmuxExitCopyMode = useMemoizedFn(() => {
    const sendExitRequest = () => {
      void sendTerminalInputRequest(
        apiBase,
        token,
        terminalSessionId,
        { data: "", mode: "tmux_exit_copy_mode" },
      );
    };

    sendExitRequest();
    window.setTimeout(sendExitRequest, 250);
    window.setTimeout(sendExitRequest, 800);
  });

  const handleScrollToBottom = useMemoizedFn(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    if (tmuxScrollbackActive) {
      requestTmuxExitCopyMode();
    }
    scrollTerminalToBottom(terminal);
    setTerminalAtBottom(true);
    setHasNewOutputBelow(false);
    setTmuxScrollbackActive(false);
    terminal.focus();
  });

  const clearSearch = useMemoizedFn(() => {
    setSearchResults(null);
    searchAddonRef.current?.clearDecorations();
    searchAddonRef.current?.clearActiveDecoration();
  });

  const runSearch = useMemoizedFn(
    (direction: SearchDirection, query = searchQuery) => {
      if (!query) {
        clearSearch();
        return;
      }

      const searchAddon = searchAddonRef.current;
      if (!searchAddon) {
        return;
      }

      if (direction === "previous") {
        searchAddon.findPrevious(query, searchOptions);
        return;
      }

      searchAddon.findNext(query, searchOptions);
    },
  );

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    onBellRef.current = onBell;
  }, [onBell]);

  useEffect(() => {
    onAuthExpiredRef.current = onAuthExpired;
  }, [onAuthExpired]);

  useEffect(() => {
    openTerminalLinkRef.current = (uri: string): void => {
      if (window.electronAPI?.isElectron !== true) {
        window.open(uri, "_blank", "noopener,noreferrer");
        return;
      }

      const nextUrl = normalizeTerminalBrowserUrl(uri);
      if (!nextUrl.ok) {
        return;
      }
      createBrowserTab(nextUrl.url);
      openBrowser();
    };
  }, [createBrowserTab, openBrowser]);

  useEffect(() => {
    onMetadataRef.current = onMetadata;
  }, [onMetadata]);

  useEffect(() => {
    tokenRef.current = token;
  }, [token]);
  useEffect(() => {
    runtimeKindRef.current = runtimeKind;
  }, [runtimeKind]);

  useTerminalEmulator({
    activeRef,
    apiBase,
    clientMode,
    imeCommitRef,
    imeCompositionEndedAtRef,
    lastResizedAtRef,
    lastSentResizeRef,
    onAuthExpired,
    onBellRef,
    openTerminalLinkRef,
    refreshTerminalViewportRef,
    runtimeKindRef,
    searchAddonRef,
    sendResize,
    sendTerminalInput,
    setPasteError,
    setPastedImages,
    setSearchResults,
    terminalContainerRef,
    terminalRef,
    terminalSessionId,
    tokenRef,
    xtermUserInputSequenceRef,
    onBottomStateChange: handleBottomStateChange,
    onTmuxScrollbackActiveChange: setTmuxScrollbackActive,
  });

  useEffect(() => {
    if (!active || !terminalRef.current) {
      return;
    }

    return scheduleTerminalViewportRefresh(
      () => {
        if (!activeRef.current || !terminalRef.current) {
          return;
        }

        terminalRef.current.focus();
        refreshTerminalViewportRef.current?.();
      },
      { delayMs: TERMINAL_RESIZE_DEBOUNCE_MS },
    );
  }, [active, layoutVersion]);

  useTerminalSnapshotRestore({
    active,
    apiBase,
    hasDeferredOutputRef,
    hasRenderedSnapshotRef,
    onAuthExpiredRef,
    onMetadataRef,
    renderTerminalSnapshot,
    replayDeferredOutput,
    requiresSnapshotRestoreRef,
    restoreSnapshotRequestRef,
    terminalRef,
    terminalSessionId,
    tokenRef,
    websocketContentVersionRef,
  });

  useEffect(() => {
    if (!searchOpen) {
      return;
    }

    const frameId = requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [searchOpen]);

  useEffect(() => {
    if (!searchOpen) {
      clearSearch();
      return;
    }

    runSearch("next");
  }, [clearSearch, runSearch, searchOpen, searchOptions, searchQuery]);

  useEffect(() => {
    if (!active) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (clientMode === "mobile") {
        return;
      }

      const openSearch =
        (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f";
      if (openSearch) {
        event.preventDefault();
        setSearchOpen(true);
        return;
      }

      if (event.key === "Escape" && searchOpen) {
        event.preventDefault();
        setSearchOpen(false);
        terminalRef.current?.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [active, clientMode, searchOpen]);

  useEffect(() => {
    if (clientMode !== "mobile") {
      return;
    }

    setSearchOpen(false);
  }, [clientMode]);

  useEffect(() => {
    if (active && clientMode === "mobile") {
      return;
    }

    setMobileKeybarOpen(false);
  }, [active, clientMode]);

  const showTerminalToolbar = active && clientMode !== "mobile";
  const showMobileKeybarToggle = active && clientMode === "mobile";

  return (
    <TerminalSurfaceLayout
      active={active}
      clientMode={clientMode}
      error={error}
      mobileKeybarOpen={mobileKeybarOpen}
      pasteError={pasteError}
      pastedImages={pastedImages}
      searchInputRef={searchInputRef}
      searchOpen={searchOpen}
      searchOptions={searchOptions}
      searchQuery={searchQuery}
      searchResults={searchResults}
      showMobileKeybarToggle={showMobileKeybarToggle}
      showScrollToBottomButton={
        active && (!terminalAtBottom || hasNewOutputBelow || tmuxScrollbackActive)
      }
      showTerminalToolbar={showTerminalToolbar}
      terminalContainerRef={terminalContainerRef}
      terminalRef={terminalRef}
      hasNewOutputBelow={hasNewOutputBelow}
      onRunSearch={runSearch}
      onSearchOpenChange={setSearchOpen}
      onSearchOptionsChange={setSearchOptions}
      onSearchQueryChange={setSearchQuery}
      onSendInput={sendTerminalInput}
      onMobileKeybarOpenChange={setMobileKeybarOpen}
      onScrollToBottom={handleScrollToBottom}
    />
  );
}
