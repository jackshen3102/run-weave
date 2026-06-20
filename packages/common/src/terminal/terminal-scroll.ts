interface TerminalScrollBuffer {
  active: {
    baseY: number;
    viewportY: number;
  };
}

export interface TerminalScrollTarget {
  buffer: TerminalScrollBuffer;
  scrollToBottom(): void;
}

export interface TerminalBottomState {
  isAtBottom: boolean;
  bottomOffsetRows: number;
}

export function getTerminalBottomState(
  terminal: TerminalScrollTarget,
  toleranceRows = 1,
): TerminalBottomState {
  const bottomOffsetRows = Math.max(
    0,
    terminal.buffer.active.baseY - terminal.buffer.active.viewportY,
  );

  return {
    isAtBottom: bottomOffsetRows <= toleranceRows,
    bottomOffsetRows,
  };
}

export function isTerminalAtBottom(
  terminal: TerminalScrollTarget,
  toleranceRows = 1,
): boolean {
  return getTerminalBottomState(terminal, toleranceRows).isAtBottom;
}

export function scrollTerminalToBottom(terminal: TerminalScrollTarget): void {
  terminal.scrollToBottom();
}
