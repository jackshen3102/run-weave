import type { FloatingDraftState, UseTerminalFloatingDraftControllerOptions } from "./floating-draft-types";
import { useRichPaste } from "../../../features/terminal/input/use-rich-paste";
import {
  useTerminalTextAttachments,
  useTextAttachmentWorkspace,
} from "../../../features/terminal/input/text-attachments";
import { terminalTextAttachmentRequest } from "../../../services/terminal/sessions";
import type { TerminalTextAttachmentOperation } from "@runweave/shared/terminal/text-attachments";
import {
  HANDOFF_INPUT_EVENT,
  type HandoffInputGuard,
} from "../../../features/terminal/input/handoff-guard";
import { useMemoizedFn } from "ahooks";
import { useEffect, useRef, useState } from "react";
import type { TerminalPromptSubmitKey } from "@runweave/shared/terminal/input";
import {
  applyTerminalDraftInput,
  getFloatingComposerQueueKey,
  shouldEnableFloatingComposer,
} from "../../../features/terminal/input/floating-composer";
import { logTerminalPerf } from "../../../features/terminal/output/performance";
import { sendTerminalInput as sendTerminalInputRequest } from "../../../services/terminal/index";
import { useTerminalInstantReplyController } from "./use-terminal-instant-reply-controller";

const INPUT_LAG_FALLBACK_DELAY_MS = 150;

export function useTerminalFloatingDraftController({
  active,
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
  const [nativeDraftMirrorSupported, setDraftMirrorSupported] = useState(true);
  const attachmentMirrorUnreliable = useRef(false);
  const [inputLagFallbackActive, setInputLagFallbackActive] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const requestScopeRef = useRef<object | null>(null);
  const sendErrorRef = useRef(sendError);
  sendErrorRef.current = sendError;
  const draftsByTargetRef = useRef(new Map<string, FloatingDraftState>());

  const activePanel = paneWorkspace?.panels.find(
    (panel) => panel.panelId === paneWorkspace.activePanelId,
  );
  const codexContext = activePanel?.codexContext;
  const codexDraftKey = codexContext === undefined ? "legacy" :
    `${codexContext?.generation ?? "unknown"}:${codexContext?.displayedThreadId ?? "unknown"}`;

  useEffect(() => {
    if (inputLagFallbackTimerRef.current !== null) {
      window.clearTimeout(inputLagFallbackTimerRef.current);
      inputLagFallbackTimerRef.current = null;
    }
    const target = JSON.stringify([
      apiBase,
      terminalSessionId,
      paneWorkspace?.activePanelId,
      codexDraftKey,
    ]);
    const draftsByTarget = draftsByTargetRef.current;
    const saved = draftsByTarget.get(target);
    requestScopeRef.current = {};
    floatingDraftRef.current = saved?.draft ?? "";
    lastSyncedTuiDraftRef.current = saved?.synced ?? "";
    floatingDraftDirtyRef.current = saved?.dirty ?? false;
    floatingDraftSyncPendingRef.current = false;
    attachmentMirrorUnreliable.current = saved?.mirrorUnreliable ?? false;
    setDraftMirrorSupported(!attachmentMirrorUnreliable.current);
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
        mirrorUnreliable: attachmentMirrorUnreliable.current,
        error: floatingDraftSyncPendingRef.current
          ? "发送结果未确认，草稿已保留。请先检查终端，再决定是否重新发送。"
          : sendErrorRef.current,
      });
      requestScopeRef.current = null;
    };
  }, [apiBase, terminalSessionId, paneWorkspace?.activePanelId, codexDraftKey]);


  const targetActiveCommand = paneWorkspace
    ? (activePanel?.activeCommand ?? null)
    : activeCommand;
  const primaryTerminalState = paneWorkspace
    ? activePanel?.terminalState
    : terminalState;
  const targetTerminalState = codexContext && primaryTerminalState ? { ...primaryTerminalState, state: codexContext.displayedRunning ? "agent_running" as const : "agent_idle" as const } : primaryTerminalState;
  const targetSessionRunning = paneWorkspace
    ? activePanel?.status === "running"
    : sessionStatus === "running";
  const eligible = (codexContext === undefined || Boolean(codexContext?.inputReady && codexContext.displayedThreadId)) && shouldEnableFloatingComposer({
    activeCommand: targetActiveCommand,
    bufferType,
    clientMode,
    searchOpen,
    sessionRunning: targetSessionRunning,
    terminalState: targetTerminalState,
  });
  const attachmentWorkspace = useTextAttachmentWorkspace({
    apiBase,
    token,
    sessionId: terminalSessionId,
    active,
    workspace: paneWorkspace,
  });
  const attachmentPanel = attachmentWorkspace?.panels.find(
    (panel) => panel.panelId === attachmentWorkspace.activePanelId,
  );
  const textAttachments = useTerminalTextAttachments(
    {
      apiBase,
      token,
      sessionId: terminalSessionId,
      panelId: attachmentWorkspace?.activePanelId ?? "",
      inputContextKey: codexDraftKey,
      threadId: codexContext !== undefined ? codexContext?.displayedThreadId ?? null :
        attachmentPanel?.threadId ??
        (attachmentPanel?.lastThreadStatus === "idle"
          ? attachmentPanel.lastThreadId
          : null) ??
        null,
      active,
    },
    () => {
      // Insertion uses the server's single delivery path; cursor position cannot be inferred from xterm output.
      attachmentMirrorUnreliable.current = true;
      clearInputLagFallbackTimer();
      setInputLagFallbackActive(false);
      setDraftMirrorSupported(false);
      setSendError(
        "TUI 路径投递后，光标草稿无法可靠镜像；请核对终端并在那里继续编辑、提交。",
      );
    },
  );
  const richPaste = useRichPaste({
    apiBase, token, sessionId: terminalSessionId, panelId: textAttachments.panelId, threadId: textAttachments.threadId, active, sending,
    captureText: textAttachments.captureText,
    onDraftChange: (value) => handleDraftChange(value),
  });
  const draftMirrorSupported =
    nativeDraftMirrorSupported && !textAttachments.mirrorUnreliable;
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
    // Native side navigation is observed separately; it does not edit this draft.
    if (codexContext !== undefined && data === "\u001f") return;
    richPaste.markInput();
    textAttachments.markInput(data === "\r" || data === "\u0015");
    if (
      attachmentMirrorUnreliable.current ||
      textAttachments.mirrorUnreliable
    ) {
      if (data === "\r" || data === "\u0015") {
        attachmentMirrorUnreliable.current = false;
        lastSyncedTuiDraftRef.current = "";
        if (!floatingDraftDirtyRef.current) {
          floatingDraftRef.current = "";
          setFloatingDraft("");
        }
        setDraftMirrorSupported(true);
        setSendError(null);
      } else return;
    }
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

    // Managed TUI state arrives independently of output. A quiet output stream
    // must not steal native keyboard focus while a slash-command popup changes.
    if (codexContext !== undefined) return;
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
    richPaste.markInput();
    textAttachments.markInput();
    floatingDraftRef.current = value;
    setFloatingDraft(value);
    floatingDraftDirtyRef.current = value !== lastSyncedTuiDraftRef.current;
  });

  const sendDraftToTui = useMemoizedFn(
    async (
      options: { submit?: boolean; submitKey?: TerminalPromptSubmitKey } = {},
    ): Promise<boolean> => {
      if (
        floatingDraftSyncPendingRef.current ||
        textAttachments.blocked ||
        richPaste.blocked ||
        attachmentMirrorUnreliable.current ||
        textAttachments.mirrorUnreliable
      ) {
        return false;
      }
      const attachmentItems = [...textAttachments.composerItems];
      const attachmentIds = [...textAttachments.ids];
      const shouldReplay =
        floatingDraftDirtyRef.current || attachmentIds.length > 0;
      if (attachmentIds.length && options.submit !== true) return false;
      const shouldSubmit = options.submit === true;
      if (!shouldReplay && !shouldSubmit) {
        return true;
      }
      if (error) {
        setSendError("终端连接不可用，草稿已保留；重连后再发送。");
        setFloatingComposerOpen(true);
        return false;
      }

      if (codexContext !== undefined && (!codexContext?.inputReady || !codexContext.displayedThreadId)) {
        setSendError("Codex 会话身份尚未就绪，草稿已保留，请在原终端继续。");
        return false;
      }
      const draftToReplay = floatingDraftRef.current;
      const scope = requestScopeRef.current;
      const panelId = attachmentIds.length
        ? textAttachments.panelId
        : paneWorkspace?.activePanelId;
      const operationId = crypto.randomUUID();
      textAttachments.markInput();
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
            ...(codexContext?.displayedThreadId ? { codexInputContext: {
              generation: codexContext.generation, revision: codexContext.revision,
              threadId: codexContext.displayedThreadId,
            } } : {}),
            ...(attachmentIds.length
              ? {
                  operationId,
                  textAttachmentIds: attachmentIds,
                  expectedThreadId: textAttachments.threadId ?? undefined,
                  recordQuickInput: false,
                }
              : {}),
            submit: shouldSubmit,
            ...(options.submitKey ? { submitKey: options.submitKey } : {}),
            ...(panelId ? { panelId } : {}),
          },
          AbortSignal.timeout(20_000),
        );
        if (attachmentIds.length) textAttachments.consume(attachmentItems);
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
        if (attachmentIds.length) {
          const known =
            await terminalTextAttachmentRequest<TerminalTextAttachmentOperation>(
              apiBase,
              token,
              terminalSessionId,
              `/operations/${operationId}`,
            ).catch(() => null);
          if (known?.status === "accepted") {
            textAttachments.consume(attachmentItems);
            if (
              requestScopeRef.current === scope &&
              floatingDraftRef.current === draftToReplay
            ) {
              floatingDraftRef.current = "";
              lastSyncedTuiDraftRef.current = "";
              floatingDraftDirtyRef.current = false;
              setFloatingDraft("");
            }
            return true;
          }
          // A fresh send ID could duplicate an unknown PTY delivery. Block until inspected.
          if (
            known?.status === "unknown" ||
            known?.status === "dispatching" ||
            !known
          ) {
            for (const item of attachmentItems) {
              item.status = "unknown";
              item.reason = "提交结果未确认，请核对终端；不会自动重发";
            }
          }
        }
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
    (draftMirrorSupported ||
      Boolean(sendError) ||
      textAttachments.composerItems.length > 0) &&
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
    codexInputContext: codexContext?.displayedThreadId ? { generation: codexContext.generation, revision: codexContext.revision, threadId: codexContext.displayedThreadId } : undefined,
    apiBase,
    available: eligible && draftMirrorSupported && !richPaste.blocked,
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
    if (!floatingDraft && !textAttachments.ids.length) {
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
    if ((!floatingDraftRef.current && !textAttachments.ids.length) || !queueKey)
      return;
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
      codexContext === undefined &&
      floatingDraftDirtyRef.current &&
      !floatingDraftSyncPendingRef.current &&
      !sendError
    ) {
      void sendDraftToTui();
    }
  }, [sendDraftToTui, sendError, visible, codexContext]);

  useEffect(() => {
    if (terminalAtBottom && !attachmentMirrorUnreliable.current) {
      setDraftMirrorSupported(true);
    }
  }, [terminalAtBottom]);

  useEffect(() => {
    if (!attachmentMirrorUnreliable.current) setDraftMirrorSupported(true);
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

  const guardHandoffInput = useMemoizedFn((event: Event) => {
    const detail = (event as CustomEvent<HandoffInputGuard>).detail;
    if (
      detail.apiBase !== apiBase ||
      detail.terminalSessionId !== terminalSessionId ||
      detail.panelId !== (paneWorkspace?.activePanelId ?? null)
    )
      return;
    if (
      richPaste.blocked ||
      !eligible ||
      !draftMirrorSupported ||
      error ||
      floatingDraftSyncPendingRef.current
    ) {
      detail.message = "终端输入未就绪或正在发送，请稍后再试。";
      return;
    }
    if (
      floatingDraftRef.current.trim() ||
      lastSyncedTuiDraftRef.current.trim()
    ) {
      detail.message = "终端中有未发送的草稿，请先处理草稿，再继续验收。";
      return;
    }
    floatingDraftSyncPendingRef.current = true;
    setSending(true);
    detail.release = () => {
      floatingDraftSyncPendingRef.current = false;
      setSending(false);
    };
  });
  useEffect(() => {
    window.addEventListener(HANDOFF_INPUT_EVENT, guardHandoffInput);
    return () =>
      window.removeEventListener(HANDOFF_INPUT_EVENT, guardHandoffInput);
  }, [guardHandoffInput]);

  const handleClose = useMemoizedFn(() => {
    richPaste.markInput();
    clearInputLagFallbackTimer();
    setInputLagFallbackActive(false);
    setFloatingComposerOpen(false);
  });
  return {
    richPaste,
    textAttachments,
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
