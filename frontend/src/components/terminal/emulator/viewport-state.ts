import type { Terminal } from "@xterm/xterm";
import {
  getTerminalBottomState,
  type TerminalBottomState,
} from "@runweave/common/terminal";

const TMUX_SCROLLBACK_BOTTOM_TOLERANCE_ROWS = 2;

interface TerminalViewportStateCallbacks {
  onBottomStateChange: (state: TerminalBottomState) => void;
  onBufferTypeChange: (type: "normal" | "alternate" | undefined) => void;
}

export function createTerminalViewportState(
  terminal: Terminal,
  callbacks: TerminalViewportStateCallbacks,
) {
  let lastBottomState: TerminalBottomState | null = null;
  let lastBufferType: "normal" | "alternate" | undefined;

  const emitBottomState = (): void => {
    const next = getTerminalBottomState(terminal);
    if (
      lastBottomState?.isAtBottom === next.isAtBottom &&
      lastBottomState.bottomOffsetRows === next.bottomOffsetRows
    ) {
      return;
    }
    lastBottomState = next;
    callbacks.onBottomStateChange(next);
  };

  const markAwayFromBottom = (): void => {
    const bottomOffsetRows = Math.max(
      (lastBottomState?.bottomOffsetRows ?? 0) + 1,
      8,
    );
    if (
      lastBottomState?.isAtBottom === false &&
      lastBottomState.bottomOffsetRows === bottomOffsetRows
    ) {
      return;
    }
    lastBottomState = { isAtBottom: false, bottomOffsetRows };
    callbacks.onBottomStateChange(lastBottomState);
  };

  const markTowardBottom = (): TerminalBottomState => {
    const bottomOffsetRows = Math.max(
      0,
      (lastBottomState?.bottomOffsetRows ?? 0) - 1,
    );
    const next = {
      isAtBottom: bottomOffsetRows <= TMUX_SCROLLBACK_BOTTOM_TOLERANCE_ROWS,
      bottomOffsetRows,
    };
    if (
      lastBottomState?.isAtBottom !== next.isAtBottom ||
      lastBottomState.bottomOffsetRows !== next.bottomOffsetRows
    ) {
      lastBottomState = next;
      callbacks.onBottomStateChange(next);
    }
    return next;
  };

  const emitBufferType = (): void => {
    const next = terminal.buffer.active.type;
    if (lastBufferType === next) {
      return;
    }
    lastBufferType = next;
    callbacks.onBufferTypeChange(next);
  };

  return {
    emitBottomState,
    emitBufferType,
    isAtBottom: () => lastBottomState?.isAtBottom === true,
    markAwayFromBottom,
    markTowardBottom,
  };
}
