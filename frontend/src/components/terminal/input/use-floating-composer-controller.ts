import { useMemoizedFn } from "ahooks";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import {
  scrollTerminalToBottom,
  type TerminalBottomState,
} from "@runweave/common/terminal";
import type { TerminalPanelWorkspace } from "@runweave/shared/terminal/panel";
import type { TerminalState } from "@runweave/shared/terminal/state";
import type { ClientMode } from "../../../features/client-mode";
import {
  applyTerminalDraftInput,
  shouldEnableFloatingComposer,
} from "../../../features/terminal/input/floating-composer";
import { logTerminalPerf } from "../../../features/terminal/output/performance";
import { sendTerminalInput as sendTerminalInputRequest } from "../../../services/terminal/index";
import type { TerminalFloatingComposerDiagnostics } from "./floating-composer";

const TMUX_EXIT_COPY_MODE_REQUEST_COOLDOWN_MS = 1_000;
const INPUT_LAG_FALLBACK_DELAY_MS = 150;

type TerminalRuntimeKindRef = RefObject<"tmux" | "pty" | null>;

interface UseTerminalScrollControllerOptions {
  active: boolean;
  apiBase: string;
  runtimeKindRef: TerminalRuntimeKindRef;
  terminalRef: RefObject<Terminal | null>;
  terminalSessionId: string;
  token: string;
}

export function useTerminalScrollController({
  active,
  apiBase,
  runtimeKindRef,
  terminalRef,
  terminalSessionId,
  token,
}: UseTerminalScrollControllerOptions) {
  const tmuxExitCopyModeRequestedAtRef = useRef(0);
  const [bottomOffsetRows, setBottomOffsetRows] = useState(0);
  const [terminalAtBottom, setTerminalAtBottom] = useState(true);
  const [hasNewOutputBelow, setHasNewOutputBelow] = useState(false);
  const [tmuxScrollbackActive, setTmuxScrollbackActive] = useState(false);

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

  const scrollToBottom = useMemoizedFn(() => {
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

  const handleBottomStateChange = useMemoizedFn(
    (state: TerminalBottomState) => {
      setTerminalAtBottom(state.isAtBottom);
      setBottomOffsetRows(state.bottomOffsetRows);
      if (state.isAtBottom) {
        setHasNewOutputBelow(false);
      }
    },
  );

  const showScrollToBottomControl =
    active && (!terminalAtBottom || hasNewOutputBelow || tmuxScrollbackActive);

  return {
    bottomOffsetRows,
    handleBottomStateChange,
    hasNewOutputBelow,
    requestTmuxExitCopyMode,
    scrollToBottom,
    setHasNewOutputBelow,
    setTerminalAtBottom,
    setTmuxScrollbackActive,
    showScrollToBottomControl,
    terminalAtBottom,
    tmuxScrollbackActive,
  };
}

interface UseTerminalFloatingDraftControllerOptions {
  activeCommand: string | null;
  apiBase: string;
  bufferType: "normal" | "alternate" | undefined;
  clientMode: ClientMode;
  error: string | null;
  paneWorkspace: TerminalPanelWorkspace | null;
  requestTmuxExitCopyMode: () => void;
  runtimeKindRef: TerminalRuntimeKindRef;
  searchOpen: boolean;
  scrollToBottom: () => void;
  sessionStatus: "running" | "exited";
  showScrollToBottomControl: boolean;
  terminalAtBottom: boolean;
  terminalSessionId: string;
  terminalState?: TerminalState;
  tmuxScrollbackActive: boolean;
  token: string;
}

function useTerminalFloatingDraftController({
  activeCommand,
  apiBase,
  bufferType,
  clientMode,
  error,
  paneWorkspace,
  requestTmuxExitCopyMode,
  runtimeKindRef,
  searchOpen,
  scrollToBottom,
  sessionStatus,
  showScrollToBottomControl,
  terminalAtBottom,
  terminalSessionId,
  terminalState,
  tmuxScrollbackActive,
  token,
}: UseTerminalFloatingDraftControllerOptions) {
  const lastSyncedTuiDraftRef = useRef("");
  const floatingDraftRef = useRef("");
  const floatingDraftDirtyRef = useRef(false);
  const floatingDraftSyncPendingRef = useRef(false);
  const floatingComposerVisibleRef = useRef(false);
  const inputLagFallbackTimerRef = useRef<number | null>(null);
  const [floatingComposerOpen, setFloatingComposerOpen] = useState(false);
  const [floatingDraft, setFloatingDraft] = useState("");
  const [draftMirrorSupported, setDraftMirrorSupported] = useState(true);
  const [inputLagFallbackActive, setInputLagFallbackActive] = useState(false);

  const eligible = shouldEnableFloatingComposer({
    activeCommand,
    bufferType,
    clientMode,
    searchOpen,
    sessionRunning: sessionStatus === "running",
    terminalState,
  });

  const clearInputLagFallbackTimer = useMemoizedFn(() => {
    if (inputLagFallbackTimerRef.current === null) {
      return;
    }
    window.clearTimeout(inputLagFallbackTimerRef.current);
    inputLagFallbackTimerRef.current = null;
  });

  const handleOutputReceived = useMemoizedFn(() => {
    clearInputLagFallbackTimer();
  });

  const handleUserInputData = useMemoizedFn((data: string) => {
    if (!eligible || !draftMirrorSupported) {
      return;
    }
    const previousDraft = lastSyncedTuiDraftRef.current;
    const next = applyTerminalDraftInput(previousDraft, data);
    if (!next.supported) {
      clearInputLagFallbackTimer();
      if (lastSyncedTuiDraftRef.current) {
        setDraftMirrorSupported(false);
      }
      return;
    }
    lastSyncedTuiDraftRef.current = next.draft;
    floatingDraftRef.current = next.draft;
    floatingDraftDirtyRef.current = false;
    setFloatingDraft(next.draft);

    if (!next.draft) {
      clearInputLagFallbackTimer();
      setInputLagFallbackActive(false);
      return;
    }
    if (
      next.draft === previousDraft ||
      floatingComposerVisibleRef.current ||
      inputLagFallbackTimerRef.current !== null
    ) {
      return;
    }
    inputLagFallbackTimerRef.current = window.setTimeout(() => {
      inputLagFallbackTimerRef.current = null;
      if (!floatingDraftRef.current || !eligible || !draftMirrorSupported) {
        return;
      }
      setInputLagFallbackActive(true);
      setFloatingComposerOpen(true);
    }, INPUT_LAG_FALLBACK_DELAY_MS);
  });

  const handleDraftChange = useMemoizedFn((value: string) => {
    setFloatingDraft(value);
    floatingDraftDirtyRef.current = value !== lastSyncedTuiDraftRef.current;
  });

  const sendDraftToTui = useMemoizedFn(
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
            if (floatingDraftRef.current !== draftToReplay) {
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

  const available =
    eligible &&
    draftMirrorSupported &&
    (showScrollToBottomControl || inputLagFallbackActive);
  const visible = available && floatingComposerOpen;
  const showTrigger = available && !floatingComposerOpen;

  const handleSend = useMemoizedFn(() => {
    if (!floatingDraft) {
      return;
    }
    if (
      !sendDraftToTui({
        delayMs: tmuxScrollbackActive ? 320 : 0,
        submit: true,
      })
    ) {
      return;
    }
    clearInputLagFallbackTimer();
    setInputLagFallbackActive(false);
    setFloatingComposerOpen(false);
    scrollToBottom();
  });

  useEffect(() => {
    floatingDraftRef.current = floatingDraft;
  }, [floatingDraft]);

  useEffect(() => {
    const wasVisible = floatingComposerVisibleRef.current;
    floatingComposerVisibleRef.current = visible;
    if (!wasVisible && visible) {
      const syncedDraft = lastSyncedTuiDraftRef.current;
      floatingDraftRef.current = syncedDraft;
      floatingDraftDirtyRef.current = false;
      setFloatingDraft(syncedDraft);
      return;
    }
    if (
      wasVisible &&
      !visible &&
      floatingDraftDirtyRef.current &&
      !floatingDraftSyncPendingRef.current
    ) {
      const syncDelayMs = runtimeKindRef.current === "tmux" ? 320 : 0;
      if (runtimeKindRef.current === "tmux") {
        requestTmuxExitCopyMode();
      }
      sendDraftToTui({ delayMs: syncDelayMs });
    }
  }, [requestTmuxExitCopyMode, runtimeKindRef, sendDraftToTui, visible]);

  useEffect(() => {
    if (terminalAtBottom) {
      setDraftMirrorSupported(true);
    }
  }, [terminalAtBottom]);

  useEffect(() => {
    setDraftMirrorSupported(true);
    clearInputLagFallbackTimer();
    setInputLagFallbackActive(false);
  }, [
    activeCommand,
    clearInputLagFallbackTimer,
    terminalSessionId,
    terminalState?.agent,
    terminalState?.state,
  ]);

  useEffect(() => {
    if (eligible) {
      return;
    }
    clearInputLagFallbackTimer();
    setInputLagFallbackActive(false);
    setFloatingComposerOpen(false);
  }, [clearInputLagFallbackTimer, eligible]);

  useEffect(
    () => () => {
      clearInputLagFallbackTimer();
    },
    [clearInputLagFallbackTimer],
  );

  const handleClose = useMemoizedFn(() => {
    clearInputLagFallbackTimer();
    setInputLagFallbackActive(false);
    setFloatingComposerOpen(false);
  });

  return {
    draft: floatingDraft,
    draftMirrorSupported,
    eligible,
    handleOutputReceived,
    handleDraftChange,
    handleSend,
    handleUserInputData,
    inputLagFallbackActive,
    onClose: handleClose,
    onOpen: () => setFloatingComposerOpen(true),
    showTrigger,
    visible,
  };
}

interface UseTerminalFloatingComposerControllerOptions {
  activeCommand: string | null;
  apiBase: string;
  clientMode: ClientMode;
  error: string | null;
  paneWorkspace: TerminalPanelWorkspace | null;
  runtimeKindRef: TerminalRuntimeKindRef;
  searchOpen: boolean;
  sessionStatus: "running" | "exited";
  scroll: ReturnType<typeof useTerminalScrollController>;
  terminalRef: RefObject<Terminal | null>;
  terminalSessionId: string;
  terminalState?: TerminalState;
  token: string;
}

export function useTerminalFloatingComposerController({
  activeCommand,
  apiBase,
  clientMode,
  error,
  paneWorkspace,
  runtimeKindRef,
  searchOpen,
  sessionStatus,
  scroll,
  terminalRef,
  terminalSessionId,
  terminalState,
  token,
}: UseTerminalFloatingComposerControllerOptions) {
  const [bufferType, setBufferType] = useState<
    "normal" | "alternate" | undefined
  >(undefined);
  const draft = useTerminalFloatingDraftController({
    activeCommand,
    apiBase,
    bufferType,
    clientMode,
    error,
    paneWorkspace,
    requestTmuxExitCopyMode: scroll.requestTmuxExitCopyMode,
    runtimeKindRef,
    searchOpen,
    scrollToBottom: scroll.scrollToBottom,
    sessionStatus,
    showScrollToBottomControl: scroll.showScrollToBottomControl,
    terminalAtBottom: scroll.terminalAtBottom,
    terminalSessionId,
    terminalState,
    tmuxScrollbackActive: scroll.tmuxScrollbackActive,
    token,
  });
  const eligible = draft.eligible;
  const visible = draft.visible;
  const showTrigger = draft.showTrigger;
  const showFloatingScroll =
    visible && (!scroll.terminalAtBottom || scroll.tmuxScrollbackActive);
  const scrollButtonMode: "floating" | "legacy" | "none" = showFloatingScroll
    ? "floating"
    : scroll.showScrollToBottomControl && !visible
      ? "legacy"
      : "none";
  const diagnostics: TerminalFloatingComposerDiagnostics = {
    activeCommand,
    bottomOffsetRows: scroll.bottomOffsetRows,
    bufferType,
    draftMirrorSupported: draft.draftMirrorSupported,
    eligible,
    inputLagFallbackActive: draft.inputLagFallbackActive,
    sessionStatus,
    terminalAgent: terminalState?.agent ?? null,
    terminalAtBottom: scroll.terminalAtBottom,
    terminalState: terminalState?.state ?? null,
    tmuxScrollbackActive: scroll.tmuxScrollbackActive,
  };

  const handleClose = useMemoizedFn(() => {
    draft.onClose();
    requestAnimationFrame(() => terminalRef.current?.focus());
  });

  return {
    diagnostics,
    draft: draft.draft,
    handleBottomStateChange: scroll.handleBottomStateChange,
    handleOutputReceived: draft.handleOutputReceived,
    handleUserInputData: draft.handleUserInputData,
    hasNewOutputBelow: scroll.hasNewOutputBelow,
    onClose: handleClose,
    onDraftChange: draft.handleDraftChange,
    onOpen: draft.onOpen,
    onScrollToBottom: scroll.scrollToBottom,
    onSend: draft.handleSend,
    onTmuxExitCopyModeRequest: scroll.requestTmuxExitCopyMode,
    scrollButtonMode,
    setBufferType,
    setHasNewOutputBelow: scroll.setHasNewOutputBelow,
    setTerminalAtBottom: scroll.setTerminalAtBottom,
    setTmuxScrollbackActive: scroll.setTmuxScrollbackActive,
    showTrigger,
    visible,
  };
}
