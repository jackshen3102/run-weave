import type { PtyRuntime } from "./pty-service";

const TmuxPostEnterInputDelayMs = 300;
const TmuxAttachReadyTimeoutMs = 5_000;
const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";

export function createTmuxInputPacedRuntime(runtime: PtyRuntime): PtyRuntime {
  const queuedInput: string[] = [];
  let holdInputUntil = 0;
  let flushTimer: NodeJS.Timeout | null = null;
  let disposed = false;
  let insideBracketedPaste = false;
  let settleReady: ((error?: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      settleReady?.(new Error("Tmux attach did not become ready within 5 seconds"));
    }, TmuxAttachReadyTimeoutMs);
    settleReady = (error) => {
      clearTimeout(timer);
      settleReady = undefined;
      if (error) reject(error);
      else resolve();
    };
  });
  runtime.onExit(({ exitCode }) => {
    settleReady?.(new Error(`Tmux attach exited before ready (${exitCode})`));
  });

  const scheduleFlush = (delayMs: number): void => {
    if (flushTimer) {
      return;
    }
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushInput();
    }, delayMs);
  };

  const flushInput = (): void => {
    if (disposed || queuedInput.length === 0) {
      return;
    }

    const delayMs = holdInputUntil - Date.now();
    if (delayMs > 0) {
      scheduleFlush(delayMs);
      return;
    }

    const next = queuedInput.shift();
    if (next === undefined) {
      return;
    }

    runtime.write(next);
    if (next === "\r" || next === "\n") {
      holdInputUntil = Date.now() + TmuxPostEnterInputDelayMs;
    }
    if (queuedInput.length > 0) {
      scheduleFlush(0);
    }
  };

  return {
    ready,
    get pid() {
      return runtime.pid;
    },
    onData(listener) {
      runtime.onData((data) => {
        if (data) settleReady?.();
        listener(data);
      });
    },
    onExit(listener) {
      runtime.onExit(listener);
    },
    write(data) {
      const splitResult = splitInputAtLineBreaks(data, insideBracketedPaste);
      insideBracketedPaste = splitResult.insideBracketedPaste;
      for (const chunk of splitResult.chunks) {
        queuedInput.push(chunk);
      }
      flushInput();
    },
    resize(cols, rows) {
      runtime.resize(cols, rows);
    },
    signal(signal) {
      runtime.signal(signal);
    },
    dispose() {
      disposed = true;
      settleReady?.(new Error("Tmux attach disposed before ready"));
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      queuedInput.length = 0;
      runtime.dispose();
    },
  };
}

function splitInputAtLineBreaks(
  data: string,
  initialInsideBracketedPaste = false,
): { chunks: string[]; insideBracketedPaste: boolean } {
  const chunks: string[] = [];
  let insideBracketedPaste = initialInsideBracketedPaste;
  let start = 0;
  for (let index = 0; index < data.length; index += 1) {
    if (data.startsWith(BRACKETED_PASTE_START, index)) {
      insideBracketedPaste = true;
      index += BRACKETED_PASTE_START.length - 1;
      continue;
    }
    if (data.startsWith(BRACKETED_PASTE_END, index)) {
      insideBracketedPaste = false;
      index += BRACKETED_PASTE_END.length - 1;
      continue;
    }
    if (insideBracketedPaste) {
      continue;
    }
    if (data[index] === "\r" || data[index] === "\n") {
      if (index > start) {
        chunks.push(data.slice(start, index));
      }
      chunks.push(data[index] ?? "");
      start = index + 1;
    }
  }
  if (start < data.length) {
    chunks.push(data.slice(start));
  }
  return {
    chunks: chunks.length > 0 ? chunks : [data],
    insideBracketedPaste,
  };
}
