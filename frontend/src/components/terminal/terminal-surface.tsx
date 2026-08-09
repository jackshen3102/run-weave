import { useMemoizedFn } from "ahooks";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import type { TerminalPanelWorkspace } from "@runweave/shared/terminal/panel";
import type { TerminalState } from "@runweave/shared/terminal/state";
import type { TerminalModeState } from "@runweave/shared/terminal/websocket";
import type { ClientMode } from "../../features/client-mode";
import {
  logTerminalPerf,
  summarizeTerminalChunk,
} from "../../features/terminal/perf-logging";
import { normalizeTerminalBrowserUrl } from "../../features/terminal/browser-url";
import { useTerminalPreviewStore } from "../../features/terminal/preview-store";
import { useTerminalConnection } from "../../features/terminal/use-terminal-connection";
import { useTerminalRuntime } from "../../features/terminal/queries/terminal-runtime-provider";
import { scheduleTerminalViewportRefresh } from "../../features/terminal/viewport-refresh";
import { useTerminalSearch } from "./surface/use-terminal-search";
import { TerminalFloatingComposer } from "./terminal-floating-composer";
import { TerminalMobileControls } from "./terminal-mobile-controls";
import { TerminalSearchToolbar } from "./terminal-search-toolbar";
import { TerminalSurfaceLayout } from "./terminal-surface-layout";
import { useTerminalEmulator } from "./use-terminal-emulator";
import {
  useTerminalFloatingComposerController,
  useTerminalScrollController,
} from "./use-terminal-floating-composer-controller";
import { useTerminalOutputStream } from "./use-terminal-output-stream";
import { useTerminalSnapshotRestore } from "./use-terminal-snapshot-restore";
import {
  IME_COMMIT_WINDOW_MS,
  TERMINAL_RESIZE_DEBOUNCE_MS,
  type TerminalImeCommit,
  type PastedImageReference,
} from "./terminal-surface-utils";

interface TerminalSurfaceProps {
  active: boolean;
  terminalSessionId: string;
  activeCommand?: string | null;
  clientMode?: ClientMode;
  layoutVersion?: string;
  paneWorkspace?: TerminalPanelWorkspace | null;
  sessionStatus?: "running" | "exited";
  terminalState?: TerminalState;
  onResizePane?: (
    panelId: string,
    direction: "left" | "right" | "up" | "down",
    cells: number,
  ) => void;
  onViewportResize?: () => void;
}

export function TerminalSurface({
  active,
  terminalSessionId,
  activeCommand = null,
  clientMode = "desktop",
  layoutVersion = "default",
  paneWorkspace = null,
  sessionStatus = "running",
  terminalState,
  onResizePane,
  onViewportResize,
}: TerminalSurfaceProps) {
  const { apiBase, onAuthExpired, token } = useTerminalRuntime();
  const terminalContainerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const createBrowserTab = useTerminalPreviewStore(
    (state) => state.createBrowserTab,
  );
  const openBrowser = useTerminalPreviewStore((state) => state.openBrowser);
  const refreshTerminalViewportRef = useRef<(() => void) | null>(null);
  const activeRef = useRef(active);
  const onViewportResizeRef = useRef(onViewportResize);
  const onAuthExpiredRef = useRef(onAuthExpired);
  const openTerminalLinkRef = useRef<(uri: string) => void>(() => undefined);
  const tokenRef = useRef(token);
  const runtimeKindRef = useRef<"tmux" | "pty" | null>(null);
  const lastResizedAtRef = useRef<number | null>(null);
  const inputSequenceRef = useRef(0);
  const outputSequenceRef = useRef(0);
  const xtermUserInputSequenceRef = useRef(0);
  const lastInputSentAtRef = useRef<number | null>(null);
  const imeCommitRef = useRef<TerminalImeCommit | null>(null);
  const imeCompositionEndedAtRef = useRef<number | null>(null);
  const hasDeferredOutputRef = useRef(false);
  const deferredOutputRef = useRef("");
  const deferredSnapshotRef = useRef<{
    data: string;
    modes?: TerminalModeState;
  } | null>(null);
  const terminalFrameRef = useRef<HTMLElement | null>(null);
  const requiresSnapshotRestoreRef = useRef(false);
  const hasRenderedSnapshotRef = useRef(false);
  const restoreSnapshotRequestRef = useRef(0);
  const websocketContentVersionRef = useRef(0);
  const lastSentResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [pastedImages, setPastedImages] = useState<PastedImageReference[]>([]);
  const [mobileKeybarOpen, setMobileKeybarOpen] = useState(false);
  const search = useTerminalSearch({ active, clientMode, terminalRef });
  const scroll = useTerminalScrollController({
    active,
    apiBase,
    runtimeKindRef,
    terminalRef,
    terminalSessionId,
    token,
  });

  const { onOutput, onSnapshot, renderTerminalSnapshot, replayDeferredOutput } =
    useTerminalOutputStream({
      activeRef,
      deferredOutputRef,
      deferredSnapshotRef,
      hasDeferredOutputRef,
      hasRenderedSnapshotRef,
      lastInputSentAtRef,
      outputSequenceRef,
      refreshTerminalViewportRef,
      requiresSnapshotRestoreRef,
      setHasNewOutputBelow: scroll.setHasNewOutputBelow,
      setTerminalAtBottom: scroll.setTerminalAtBottom,
      setTmuxScrollbackActive: scroll.setTmuxScrollbackActive,
      terminalRef,
      terminalFrameRef,
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
  });

  const sendTerminalInput = useMemoizedFn((data: string): void => {
    const now = performance.now();
    const imeCommit = imeCommitRef.current;
    if (
      imeCommit &&
      data === imeCommit.data &&
      now - imeCommit.at <= IME_COMMIT_WINDOW_MS
    ) {
      if (imeCommit.forwarded) {
        return;
      }
      imeCommit.forwarded = true;
    }

    inputSequenceRef.current += 1;
    lastInputSentAtRef.current = Date.now();
    logTerminalPerf("terminal.input.captured", {
      terminalSessionId,
      seq: inputSequenceRef.current,
      ...summarizeTerminalChunk(data),
    });
    sendInput(data);
  });
  const floatingComposer = useTerminalFloatingComposerController({
    activeCommand,
    apiBase,
    clientMode,
    error,
    paneWorkspace,
    runtimeKindRef,
    searchOpen: search.open,
    scroll,
    sessionStatus,
    terminalRef,
    terminalSessionId,
    terminalState,
    token,
  });

  useLayoutEffect(() => {
    activeRef.current = active;
    const rows = terminalRef.current?.element?.querySelector<HTMLElement>(
      ".xterm-rows:not([data-terminal-frame-overlay])",
    );
    if (rows?.textContent) {
      terminalFrameRef.current = rows.cloneNode(true) as HTMLElement;
    }
  }, [active]);

  useEffect(() => {
    onViewportResizeRef.current = onViewportResize;
  }, [onViewportResize]);

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
    onBufferTypeChange: floatingComposer.setBufferType,
    onViewportResizeRef,
    onUserInputData: floatingComposer.handleUserInputData,
    openTerminalLinkRef,
    refreshTerminalViewportRef,
    runtimeKindRef,
    searchAddonRef: search.addonRef,
    sendResize,
    sendTerminalInput,
    setPasteError,
    setPastedImages,
    setSearchResults: search.setResults,
    terminalContainerRef,
    terminalRef,
    terminalSessionId,
    tokenRef,
    xtermUserInputSequenceRef,
    onBottomStateChange: floatingComposer.handleBottomStateChange,
    onTmuxScrollbackActiveChange: floatingComposer.setTmuxScrollbackActive,
    onTmuxExitCopyModeRequest: floatingComposer.onTmuxExitCopyModeRequest,
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
    deferredSnapshotRef,
    hasDeferredOutputRef,
    hasRenderedSnapshotRef,
    onAuthExpiredRef,
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
    if (active && clientMode === "mobile") {
      return;
    }

    setMobileKeybarOpen(false);
  }, [active, clientMode]);

  const showTerminalToolbar = active && clientMode !== "mobile";
  const showMobileKeybarToggle = active && clientMode === "mobile";
  const showPaneResizeHandle =
    active && clientMode !== "mobile" && Boolean(onResizePane);
  return (
    <TerminalSurfaceLayout
      active={active}
      error={error ?? pasteError}
      pastedImages={pastedImages}
      paneWorkspace={showPaneResizeHandle ? paneWorkspace : null}
      toolbar={
        showTerminalToolbar ? (
          <TerminalSearchToolbar
            inputRef={search.inputRef}
            open={search.open}
            query={search.query}
            results={search.results}
            options={search.options}
            onQueryChange={search.setQuery}
            onOptionsChange={search.setOptions}
            onRunSearch={search.run}
            onOpenChange={search.setOpen}
            onCloseFocus={() => terminalRef.current?.focus()}
          />
        ) : null
      }
      mobileControls={
        showMobileKeybarToggle ? (
          <TerminalMobileControls
            active={active}
            open={mobileKeybarOpen}
            terminalRef={terminalRef}
            onOpenChange={setMobileKeybarOpen}
            onSendInput={sendTerminalInput}
          />
        ) : null
      }
      controls={
        <TerminalFloatingComposer
          diagnostics={floatingComposer.diagnostics}
          draft={floatingComposer.draft}
          hasNewOutputBelow={floatingComposer.hasNewOutputBelow}
          scrollButtonMode={floatingComposer.scrollButtonMode}
          showTrigger={floatingComposer.showTrigger}
          terminalRef={terminalRef}
          visible={floatingComposer.visible}
          onClose={floatingComposer.onClose}
          onDraftChange={floatingComposer.onDraftChange}
          onOpen={floatingComposer.onOpen}
          onScrollToBottom={floatingComposer.onScrollToBottom}
          onSend={floatingComposer.onSend}
        />
      }
      terminalContainerRef={terminalContainerRef}
      terminalRef={terminalRef}
      onResizePane={onResizePane}
    />
  );
}
