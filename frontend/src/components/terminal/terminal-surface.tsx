import { useMemoizedFn } from "ahooks";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import {
  scrollTerminalToBottom,
  type TerminalBottomState,
} from "@runweave/common/terminal";
import type { TerminalPanelWorkspace } from "@runweave/shared/terminal/panel";
import type { TerminalState } from "@runweave/shared/terminal/state";
import type { TerminalModeState } from "@runweave/shared/terminal/websocket";
import type { ClientMode } from "../../features/client-mode";
import {
  applyTerminalDraftInput,
  shouldEnableFloatingComposer,
} from "../../features/terminal/floating-composer";
import {
  logTerminalPerf,
  summarizeTerminalChunk,
} from "../../features/terminal/perf-logging";
import { normalizeTerminalBrowserUrl } from "../../features/terminal/browser-url";
import { useTerminalPreviewStore } from "../../features/terminal/preview-store";
import { useTerminalConnection } from "../../features/terminal/use-terminal-connection";
import { useTerminalRuntime } from "../../features/terminal/queries/terminal-runtime-provider";
import { scheduleTerminalViewportRefresh } from "../../features/terminal/viewport-refresh";
import { sendTerminalInput as sendTerminalInputRequest } from "../../services/terminal";
import { useTerminalSearch } from "./surface/use-terminal-search";
import { TerminalFloatingComposer } from "./terminal-floating-composer";
import { TerminalMobileControls } from "./terminal-mobile-controls";
import { TerminalSearchToolbar } from "./terminal-search-toolbar";
import { TerminalSurfaceLayout } from "./terminal-surface-layout";
import { useTerminalEmulator } from "./use-terminal-emulator";
import { useTerminalOutputStream } from "./use-terminal-output-stream";
import { useTerminalSnapshotRestore } from "./use-terminal-snapshot-restore";
import {
  IME_COMMIT_WINDOW_MS,
  TERMINAL_RESIZE_DEBOUNCE_MS,
  type TerminalImeCommit,
  type PastedImageReference,
} from "./terminal-surface-utils";

const TMUX_EXIT_COPY_MODE_REQUEST_COOLDOWN_MS = 1_000;

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
  const lastSyncedTuiDraftRef = useRef("");
  const floatingDraftRef = useRef("");
  const floatingDraftDirtyRef = useRef(false);
  const floatingDraftSyncPendingRef = useRef(false);
  const floatingComposerVisibleRef = useRef(false);
  const tmuxExitCopyModeRequestedAtRef = useRef(0);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [pastedImages, setPastedImages] = useState<PastedImageReference[]>([]);
  const [bufferType, setBufferType] = useState<
    "normal" | "alternate" | undefined
  >(undefined);
  const [bottomOffsetRows, setBottomOffsetRows] = useState(0);
  const [floatingComposerOpen, setFloatingComposerOpen] = useState(false);
  const [floatingDraft, setFloatingDraft] = useState("");
  const [draftMirrorSupported, setDraftMirrorSupported] = useState(true);
  const [mobileKeybarOpen, setMobileKeybarOpen] = useState(false);
  const [terminalAtBottom, setTerminalAtBottom] = useState(true);
  const [hasNewOutputBelow, setHasNewOutputBelow] = useState(false);
  const [tmuxScrollbackActive, setTmuxScrollbackActive] = useState(false);
  const search = useTerminalSearch({ active, clientMode, terminalRef });

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
      setHasNewOutputBelow,
      setTerminalAtBottom,
      setTmuxScrollbackActive,
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

  const floatingComposerEligible = shouldEnableFloatingComposer({
    activeCommand,
    bufferType,
    clientMode,
    searchOpen: search.open,
    sessionRunning: sessionStatus === "running",
    terminalState,
  });

  const handleBottomStateChange = useMemoizedFn(
    (state: TerminalBottomState) => {
      setTerminalAtBottom(state.isAtBottom);
      setBottomOffsetRows(state.bottomOffsetRows);
      if (state.isAtBottom) {
        setHasNewOutputBelow(false);
      }
    },
  );

  const handleUserInputData = useMemoizedFn((data: string) => {
    if (!floatingComposerEligible || !draftMirrorSupported) {
      return;
    }

    const next = applyTerminalDraftInput(lastSyncedTuiDraftRef.current, data);
    if (!next.supported) {
      if (!lastSyncedTuiDraftRef.current) {
        return;
      }

      setDraftMirrorSupported(false);
      return;
    }

    lastSyncedTuiDraftRef.current = next.draft;
    floatingDraftDirtyRef.current = false;
    setFloatingDraft(next.draft);
  });

  const handleFloatingDraftChange = useMemoizedFn((value: string) => {
    setFloatingDraft(value);
    floatingDraftDirtyRef.current = value !== lastSyncedTuiDraftRef.current;
  });

  const sendFloatingDraftToTui = useMemoizedFn(
    (options: { delayMs?: number; submit?: boolean } = {}): boolean => {
      const shouldReplay = floatingDraftDirtyRef.current;
      const shouldSubmit = options.submit === true;
      if (!shouldReplay && !shouldSubmit) {
        return true;
      }

      if (error) {
        return false;
      }

      const draftToReplay = floatingDraft;
      const sendSequence = () => {
        floatingDraftSyncPendingRef.current = true;
        void sendTerminalInputRequest(apiBase, token, terminalSessionId, {
          data: draftToReplay,
          mode: "prompt_replace",
          submit: shouldSubmit,
          ...(paneWorkspace?.activePanelId
            ? { panelId: paneWorkspace.activePanelId }
            : {}),
        })
          .then(() => {
            floatingDraftSyncPendingRef.current = false;
            const draftStillCurrent =
              floatingDraftRef.current === draftToReplay;
            if (!draftStillCurrent) {
              return;
            }

            lastSyncedTuiDraftRef.current = shouldSubmit ? "" : draftToReplay;
            floatingDraftDirtyRef.current = false;

            if (shouldSubmit) {
              setFloatingDraft("");
            }
          })
          .catch((requestError: unknown) => {
            logTerminalPerf("terminal.floating_composer.sync.failed", {
              terminalSessionId,
              error: String(requestError),
            });
            floatingDraftSyncPendingRef.current = false;
          });
      };

      if (options.delayMs && options.delayMs > 0) {
        window.setTimeout(sendSequence, options.delayMs);
      } else {
        sendSequence();
      }

      return true;
    },
  );

  const requestTmuxExitCopyMode = useMemoizedFn(() => {
    const now = Date.now();
    if (
      now - tmuxExitCopyModeRequestedAtRef.current <
      TMUX_EXIT_COPY_MODE_REQUEST_COOLDOWN_MS
    ) {
      return;
    }
    tmuxExitCopyModeRequestedAtRef.current = now;

    const sendExitRequest = () => {
      void sendTerminalInputRequest(apiBase, token, terminalSessionId, {
        data: "",
        mode: "tmux_exit_copy_mode",
      });
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
    if (runtimeKindRef.current === "tmux") {
      requestTmuxExitCopyMode();
    }
    scrollTerminalToBottom(terminal);
    setTerminalAtBottom(true);
    setBottomOffsetRows(0);
    setHasNewOutputBelow(false);
    setTmuxScrollbackActive(false);
    terminal.focus();
  });

  const handleFloatingComposerScrollToBottom = useMemoizedFn(() => {
    handleScrollToBottom();
  });

  const handleFloatingComposerSend = useMemoizedFn(() => {
    if (!floatingDraft) {
      return;
    }

    const replayDelayMs = tmuxScrollbackActive ? 320 : 0;
    if (
      !sendFloatingDraftToTui({
        delayMs: replayDelayMs,
        submit: true,
      })
    ) {
      return;
    }

    handleScrollToBottom();
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
    floatingDraftRef.current = floatingDraft;
  }, [floatingDraft]);

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
    onBufferTypeChange: setBufferType,
    onViewportResizeRef,
    onUserInputData: handleUserInputData,
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
    onBottomStateChange: handleBottomStateChange,
    onTmuxScrollbackActiveChange: setTmuxScrollbackActive,
    onTmuxExitCopyModeRequest: requestTmuxExitCopyMode,
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

  const showScrollToBottomControl =
    active && (!terminalAtBottom || hasNewOutputBelow || tmuxScrollbackActive);
  const floatingComposerAvailable =
    floatingComposerEligible &&
    draftMirrorSupported &&
    showScrollToBottomControl;
  const floatingComposerVisible =
    floatingComposerAvailable && floatingComposerOpen;
  const showFloatingComposerTrigger =
    floatingComposerAvailable && !floatingComposerOpen;

  useEffect(() => {
    const wasVisible = floatingComposerVisibleRef.current;
    floatingComposerVisibleRef.current = floatingComposerVisible;

    if (!wasVisible && floatingComposerVisible) {
      const syncedDraft = lastSyncedTuiDraftRef.current;
      floatingDraftRef.current = syncedDraft;
      floatingDraftDirtyRef.current = false;
      setFloatingDraft(syncedDraft);
      return;
    }

    if (
      wasVisible &&
      !floatingComposerVisible &&
      floatingDraftDirtyRef.current &&
      !floatingDraftSyncPendingRef.current
    ) {
      const syncDelayMs = runtimeKindRef.current === "tmux" ? 320 : 0;
      if (runtimeKindRef.current === "tmux") {
        requestTmuxExitCopyMode();
      }
      sendFloatingDraftToTui({ delayMs: syncDelayMs });
    }
  }, [
    floatingComposerVisible,
    requestTmuxExitCopyMode,
    sendFloatingDraftToTui,
  ]);

  useEffect(() => {
    if (!terminalAtBottom) {
      return;
    }

    setDraftMirrorSupported(true);
  }, [terminalAtBottom]);

  useEffect(() => {
    setDraftMirrorSupported(true);
  }, [
    activeCommand,
    terminalSessionId,
    terminalState?.agent,
    terminalState?.state,
  ]);

  const showTerminalToolbar = active && clientMode !== "mobile";
  const showMobileKeybarToggle = active && clientMode === "mobile";
  const showPaneResizeHandle =
    active && clientMode !== "mobile" && Boolean(onResizePane);
  const showFloatingComposerScrollButton =
    floatingComposerVisible && (!terminalAtBottom || tmuxScrollbackActive);
  const scrollButtonMode = showFloatingComposerScrollButton
    ? "floating"
    : showScrollToBottomControl && !floatingComposerVisible
      ? "legacy"
      : "none";

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
          diagnostics={{
            activeCommand,
            bottomOffsetRows,
            bufferType,
            draftMirrorSupported,
            eligible: floatingComposerEligible,
            sessionStatus,
            terminalAgent: terminalState?.agent ?? null,
            terminalAtBottom,
            terminalState: terminalState?.state ?? null,
            tmuxScrollbackActive,
          }}
          draft={floatingDraft}
          hasNewOutputBelow={hasNewOutputBelow}
          scrollButtonMode={scrollButtonMode}
          showTrigger={showFloatingComposerTrigger}
          terminalRef={terminalRef}
          visible={floatingComposerVisible}
          onClose={() => {
            setFloatingComposerOpen(false);
            requestAnimationFrame(() => terminalRef.current?.focus());
          }}
          onDraftChange={handleFloatingDraftChange}
          onOpen={() => setFloatingComposerOpen(true)}
          onScrollToBottom={handleFloatingComposerScrollToBottom}
          onSend={handleFloatingComposerSend}
        />
      }
      terminalContainerRef={terminalContainerRef}
      terminalRef={terminalRef}
      onResizePane={onResizePane}
    />
  );
}
