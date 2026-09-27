import { useMemoizedFn } from "ahooks";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { TerminalPanelWorkspace } from "@runweave/shared/terminal/panel";
import type { TerminalState } from "@runweave/shared/terminal/state";
import type { TerminalPromptSubmitKey } from "@runweave/shared/terminal/input";
import type { ClientMode } from "../../../features/client-mode";
import {
  applyTerminalDraftInput,
  getFloatingComposerQueueKey,
  shouldEnableFloatingComposer,
} from "../../../features/terminal/input/floating-composer";
import { logTerminalPerf } from "../../../features/terminal/output/performance";
import { sendTerminalInput as sendTerminalInputRequest } from "../../../services/terminal/index";
import type { TerminalFloatingComposerDiagnostics } from "./floating-composer";
import { useTerminalInstantReplyController } from "./use-terminal-instant-reply-controller";
import type { TerminalScrollController } from "./use-terminal-scroll-controller";

const INPUT_LAG_FALLBACK_DELAY_MS = 150;

interface UseTerminalFloatingDraftControllerOptions {
  activeCommand: string | null;
  apiBase: string;
  bufferType: "normal" | "alternate" | undefined;
  clientMode: ClientMode;
  error: string | null;
  paneWorkspace: TerminalPanelWorkspace | null;
  searchOpen: boolean;
  scrollToBottom: () => void;
  sessionStatus: "running" | "exited";
  showScrollToBottomControl: boolean;
  terminalAtBottom: boolean;
  terminalSessionId: string;
  terminalState?: TerminalState;
  token: string;
}

function useTerminalFloatingDraftController({
  activeCommand,
  apiBase,
  bufferType,
  clientMode,
  error,
  paneWorkspace,
  searchOpen,
  scrollToBottom,
  sessionStatus,
  showScrollToBottomControl,
  terminalAtBottom,
  terminalSessionId,
  terminalState,
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
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const requestScopeRef = useRef<object | null>(null);
  const sendErrorRef = useRef(sendError);
  sendErrorRef.current = sendError;
  const draftsByTargetRef = useRef(
    new Map<
      string,
      {
        draft: string;
        synced: string;
        dirty: boolean;
        error: string | null;
      }
    >(),
  );

  useEffect(() => {
    if (inputLagFallbackTimerRef.current !== null) {
      window.clearTimeout(inputLagFallbackTimerRef.current);
      inputLagFallbackTimerRef.current = null;
    }
    const target = JSON.stringify([
      apiBase,
      terminalSessionId,
      paneWorkspace?.activePanelId,
    ]);
    const draftsByTarget = draftsByTargetRef.current;
    const saved = draftsByTarget.get(target);
    requestScopeRef.current = {};
    floatingDraftRef.current = saved?.draft ?? "";
    lastSyncedTuiDraftRef.current = saved?.synced ?? "";
    floatingDraftDirtyRef.current = saved?.dirty ?? false;
    floatingDraftSyncPendingRef.current = false;
    floatingComposerVisibleRef.current = false;
    setFloatingDraft(floatingDraftRef.current);
    setSendError(saved?.error ?? null);
    setFloatingComposerOpen(Boolean(saved?.dirty || saved?.error));
    setSending(false);
    setInputLagFallbackActive(false);
    return () => {
      draftsByTarget.set(target, {
        draft: floatingDraftRef.current,
        synced: lastSyncedTuiDraftRef.current,
        dirty: floatingDraftDirtyRef.current,
        error: floatingDraftSyncPendingRef.current
          ? "发送结果未确认，草稿已保留。请先检查终端，再决定是否重新发送。"
          : sendErrorRef.current,
      });
      requestScopeRef.current = null;
    };
  }, [apiBase, terminalSessionId, paneWorkspace?.activePanelId]);

  const activePanel = paneWorkspace?.panels.find(
    (panel) => panel.panelId === paneWorkspace.activePanelId,
  );
  const targetActiveCommand = paneWorkspace
    ? (activePanel?.activeCommand ?? null)
    : activeCommand;
  const targetTerminalState = paneWorkspace
    ? activePanel?.terminalState
    : terminalState;
  const targetSessionRunning = paneWorkspace
    ? activePanel?.status === "running"
    : sessionStatus === "running";
  const eligible = shouldEnableFloatingComposer({
    activeCommand: targetActiveCommand,
    bufferType,
    clientMode,
    searchOpen,
    sessionRunning: targetSessionRunning,
    terminalState: targetTerminalState,
  });
  const queueKey = getFloatingComposerQueueKey({
    activeCommand: targetActiveCommand,
    terminalState: targetTerminalState,
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
    // Raw terminal input must not overwrite an unsent local edit or an in-flight send.
    if (floatingDraftDirtyRef.current || floatingDraftSyncPendingRef.current) {
      return;
    }
    floatingDraftRef.current = next.draft;
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
    floatingDraftRef.current = value;
    setFloatingDraft(value);
    floatingDraftDirtyRef.current = value !== lastSyncedTuiDraftRef.current;
  });

  const sendDraftToTui = useMemoizedFn(
    async (
      options: { submit?: boolean; submitKey?: TerminalPromptSubmitKey } = {},
    ): Promise<boolean> => {
      if (floatingDraftSyncPendingRef.current) {
        return false;
      }
      const shouldReplay = floatingDraftDirtyRef.current;
      const shouldSubmit = options.submit === true;
      if (!shouldReplay && !shouldSubmit) {
        return true;
      }
      if (error) {
        setSendError("终端连接不可用，草稿已保留；重连后再发送。");
        setFloatingComposerOpen(true);
        return false;
      }

      const draftToReplay = floatingDraftRef.current;
      const scope = requestScopeRef.current;
      const panelId = paneWorkspace?.activePanelId;
      floatingDraftSyncPendingRef.current = true;
      setSending(true);
      setSendError(null);
      try {
        if (!scope || requestScopeRef.current !== scope) {
          return false;
        }
        await sendTerminalInputRequest(
          apiBase,
          token,
          terminalSessionId,
          {
            data: draftToReplay,
            mode: "prompt_replace",
            submit: shouldSubmit,
            ...(options.submitKey ? { submitKey: options.submitKey } : {}),
            ...(panelId ? { panelId } : {}),
          },
          AbortSignal.timeout(20_000),
        );
        if (requestScopeRef.current !== scope) {
          return false;
        }
        lastSyncedTuiDraftRef.current = shouldSubmit ? "" : draftToReplay;
        if (floatingDraftRef.current !== draftToReplay) {
          return false;
        }
        floatingDraftDirtyRef.current = false;
        if (shouldSubmit) {
          floatingDraftRef.current = "";
          setFloatingDraft("");
        }
        return true;
      } catch (requestError) {
        if (requestScopeRef.current !== scope) {
          return false;
        }
        logTerminalPerf("terminal.floating_composer.sync.failed", {
          terminalSessionId,
          error: String(requestError),
        });
        floatingDraftDirtyRef.current = true;
        setSendError(
          "发送结果未确认，草稿已保留。请先检查终端，再决定是否重新发送。",
        );
        setFloatingComposerOpen(true);
        return false;
      } finally {
        if (requestScopeRef.current === scope) {
          floatingDraftSyncPendingRef.current = false;
          setSending(false);
        }
      }
    },
  );

  const available =
    eligible &&
    draftMirrorSupported &&
    (showScrollToBottomControl ||
      inputLagFallbackActive ||
      floatingComposerOpen ||
      sending ||
      Boolean(sendError));
  const visible = available && floatingComposerOpen;
  const showTrigger = available && !floatingComposerOpen;
  const handleInstantReplySent = useMemoizedFn(() => {
    lastSyncedTuiDraftRef.current = "";
    floatingDraftDirtyRef.current = floatingDraftRef.current.length > 0;
    if (floatingDraftDirtyRef.current) {
      setFloatingComposerOpen(true);
    }
  });
  const instantReply = useTerminalInstantReplyController({
    apiBase,
    available: eligible && draftMirrorSupported,
    error,
    onSent: handleInstantReplySent,
    panelId: paneWorkspace?.activePanelId,
    requestScopeRef,
    sendPendingRef: floatingDraftSyncPendingRef,
    setSending,
    terminalSessionId,
    token,
  });

  const handleSend = useMemoizedFn(async () => {
    if (!floatingDraft) {
      return;
    }
    if (
      !(await sendDraftToTui({
        submit: true,
      }))
    ) {
      return;
    }
    clearInputLagFallbackTimer();
    setInputLagFallbackActive(false);
    setFloatingComposerOpen(false);
    scrollToBottom();
  });

  const handleQueue = useMemoizedFn(async () => {
    if (!floatingDraftRef.current || !queueKey) return;
    if (!(await sendDraftToTui({ submit: true, submitKey: queueKey }))) return;
    clearInputLagFallbackTimer();
    setInputLagFallbackActive(false);
    setFloatingComposerOpen(true);
  });

  useEffect(() => {
    const wasVisible = floatingComposerVisibleRef.current;
    floatingComposerVisibleRef.current = visible;
    if (
      !wasVisible &&
      visible &&
      !floatingDraftDirtyRef.current &&
      !floatingDraftSyncPendingRef.current
    ) {
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
      !floatingDraftSyncPendingRef.current &&
      !sendError
    ) {
      void sendDraftToTui();
    }
  }, [sendDraftToTui, sendError, visible]);

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
    targetActiveCommand,
    clearInputLagFallbackTimer,
    terminalSessionId,
    targetTerminalState?.agent,
    targetTerminalState?.state,
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
    sending,
    sendError,
    draftMirrorSupported,
    eligible,
    handleOutputReceived,
    handleDraftChange,
    handleSend,
    handleQueue,
    queueKey,
    handleUserInputData,
    inputLagFallbackActive,
    instantReplyAvailable: instantReply.available,
    instantReplyFeedback: instantReply.feedback,
    instantReplyOpen: instantReply.open,
    onClose: handleClose,
    onInstantReplyClose: instantReply.onClose,
    onInstantReplyOpen: instantReply.onOpen,
    onInstantReplySend: instantReply.onSend,
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
  searchOpen: boolean;
  sessionStatus: "running" | "exited";
  scroll: TerminalScrollController;
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
    searchOpen,
    scrollToBottom: scroll.scrollToBottom,
    sessionStatus,
    showScrollToBottomControl: scroll.showScrollToBottomControl,
    terminalAtBottom: scroll.terminalAtBottom,
    terminalSessionId,
    terminalState,
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

  const handleInstantReplyClose = useMemoizedFn(() => {
    draft.onInstantReplyClose();
    requestAnimationFrame(() => terminalRef.current?.focus());
  });

  return {
    diagnostics,
    draft: draft.draft,
    sending: draft.sending,
    sendError: draft.sendError,
    handleBottomStateChange: scroll.handleBottomStateChange,
    handleOutputReceived: draft.handleOutputReceived,
    handleUserInputData: draft.handleUserInputData,
    hasNewOutputBelow: scroll.hasNewOutputBelow,
    instantReplyAvailable: draft.instantReplyAvailable,
    instantReplyFeedback: draft.instantReplyFeedback,
    instantReplyOpen: draft.instantReplyOpen,
    onClose: handleClose,
    onDraftChange: draft.handleDraftChange,
    onInstantReplyClose: handleInstantReplyClose,
    onInstantReplyOpen: draft.onInstantReplyOpen,
    onInstantReplySend: draft.onInstantReplySend,
    onOpen: draft.onOpen,
    onScrollToBottom: scroll.scrollToBottom,
    onSend: draft.handleSend,
    onQueue: draft.handleQueue,
    queueKey: draft.queueKey,
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
