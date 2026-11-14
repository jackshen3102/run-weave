import type { TerminalScrollState } from "@runweave/shared/terminal/websocket";
import { useMemoizedFn } from "ahooks";
import { useRef, useState, type RefObject } from "react";
import {
  scrollTerminalToBottom,
  type TerminalBottomState,
} from "@runweave/common/terminal";
import type { Terminal } from "@xterm/xterm";
import { sendTerminalInput as sendTerminalInputRequest } from "../../../services/terminal/index";

const TMUX_EXIT_COPY_MODE_REQUEST_COOLDOWN_MS = 1_000;

interface UseTerminalScrollControllerOptions {
  active: boolean;
  apiBase: string;
  runtimeKindRef: RefObject<"tmux" | "pty" | null>;
  terminalRef: RefObject<Terminal | null>;
  terminalSessionId: string;
  token: string;
  resetScrollInput?: () => void;
  refreshRemoteState?: () => void;
}

export function useTerminalScrollController({
  active,
  apiBase,
  runtimeKindRef,
  terminalRef,
  terminalSessionId,
  token,
  resetScrollInput,
  refreshRemoteState,
}: UseTerminalScrollControllerOptions) {
  const remoteState = useRef<TerminalScrollState | null>(null);
  const [remoteApplication, setRemoteApplication] = useState(false);
  const tmuxExitCopyModeRequestedAtRef = useRef(0);
  const [bottomOffsetRows, setBottomOffsetRows] = useState(0);
  const [terminalAtBottom, setTerminalAtBottom] = useState(true);
  const [hasNewOutputBelow, setHasNewOutputBelow] = useState(false);
  const [tmuxScrollbackActive, setTmuxScrollbackActive] = useState(false);

  const requestTmuxExitCopyMode = useMemoizedFn(() => {
    resetScrollInput?.();
    if (remoteState.current) {
      void sendTerminalInputRequest(apiBase, token, terminalSessionId, { data: "", mode: "tmux_exit_copy_mode" })
        .then(() => refreshRemoteState?.()).catch(() => refreshRemoteState?.());
      return;
    }
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
      if (remoteState.current) return;
      setTerminalAtBottom(state.isAtBottom);
      setBottomOffsetRows(state.bottomOffsetRows);
      if (state.isAtBottom) {
        setHasNewOutputBelow(false);
      }
    },
  );

  const showScrollToBottomControl =
    active && !remoteApplication && (!terminalAtBottom || hasNewOutputBelow || tmuxScrollbackActive);

  return {
    remoteApplication,
    clearRemoteState: useMemoizedFn(() => { remoteState.current = null; setRemoteApplication(false); }),
    applyRemoteState: useMemoizedFn((state: TerminalScrollState) => {
      remoteState.current = state;
      setRemoteApplication(state.owner === "application");
      setTmuxScrollbackActive(state.copyMode);
      setBottomOffsetRows(state.offsetRows ?? 0);
      setTerminalAtBottom(!state.copyMode);
      if (!state.copyMode) setHasNewOutputBelow(false);
    }),
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

export type TerminalScrollController = ReturnType<
  typeof useTerminalScrollController
>;
