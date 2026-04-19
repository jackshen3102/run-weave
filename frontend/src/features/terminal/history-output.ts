interface HistoryTerminal {
  write(data: string, callback?: () => void): void;
  scrollToBottom(): void;
}

interface SizableHistoryTerminal {
  rows: number;
  resize(cols: number, rows: number): void;
  refresh(start: number, end: number): void;
}

interface HistoryFitAddon {
  fit(): void;
  proposeDimensions(): { cols: number; rows: number } | undefined;
}

function normalizeSourceCols(sourceCols?: number): number | null {
  if (!Number.isFinite(sourceCols) || !sourceCols || sourceCols <= 0) {
    return null;
  }
  return Math.floor(sourceCols);
}

export function syncTerminalHistorySize({
  terminal,
  fitAddon,
  sourceCols,
}: {
  terminal: SizableHistoryTerminal;
  fitAddon: HistoryFitAddon;
  sourceCols?: number;
}): void {
  const normalizedSourceCols = normalizeSourceCols(sourceCols);
  if (normalizedSourceCols) {
    const proposedDimensions = fitAddon.proposeDimensions();
    if (!proposedDimensions) {
      return;
    }
    terminal.resize(normalizedSourceCols, proposedDimensions.rows);
  } else {
    fitAddon.fit();
  }

  terminal.refresh(0, Math.max(terminal.rows - 1, 0));
}

export function writeTerminalHistoryOutput({
  terminal,
  output,
  syncSize,
}: {
  terminal: HistoryTerminal;
  output: string;
  syncSize: () => void;
}): void {
  syncSize();
  if (!output) {
    return;
  }

  const normalizedOutput = output.replace(/\r?\n/g, "\r\n");
  terminal.write(normalizedOutput, () => {
    syncSize();
    terminal.scrollToBottom();
  });
}
