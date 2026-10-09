import { useMemoizedFn } from "ahooks";
import { useState, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { TerminalPanelWorkspace } from "@runweave/shared/terminal/panel";
import type { TerminalState } from "@runweave/shared/terminal/state";
import type { ClientMode } from "../../../features/client-mode";
import type { TerminalFloatingComposerDiagnostics } from "./floating-composer";
import type { TerminalScrollController } from "./use-terminal-scroll-controller";
import { useTerminalFloatingDraftController } from "./use-floating-draft-controller";

interface UseTerminalFloatingComposerControllerOptions {
  active: boolean;
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
  active,
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
    active,
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
    textAttachments: draft.textAttachments,
    richPaste: draft.richPaste,
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
