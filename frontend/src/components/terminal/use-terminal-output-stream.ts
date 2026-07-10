import { useMemoizedFn } from "ahooks";
import type { Dispatch, SetStateAction } from "react";
import type { Terminal } from "@xterm/xterm";
import { isTerminalAtBottom } from "@runweave/common/terminal";
import {
  logTerminalPerf,
  summarizeTerminalChunk,
} from "../../features/terminal/perf-logging";
import { filterBrowserHandledTerminalOutput } from "../../features/terminal/output-filter";
import {
  DEFERRED_OUTPUT_REPLAY_MAX_CHARS,
  recordTerminalPerfProbeEvent,
} from "./terminal-surface-utils";

type MutableRef<T> = {
  current: T;
};

const SYNCHRONIZED_OUTPUT_START = "\u001b[?2026h";
const SYNCHRONIZED_OUTPUT_END = "\u001b[?2026l";

function wrapSynchronizedOutput(data: string): string {
  return `${SYNCHRONIZED_OUTPUT_START}${data}${SYNCHRONIZED_OUTPUT_END}`;
}

function preserveTerminalFrame(
  terminal: Terminal,
  terminalSessionId: string,
  terminalFrameRef: MutableRef<HTMLElement | null>,
): () => void {
  const screen = terminal.element?.querySelector<HTMLElement>(".xterm-screen");
  const rows = screen?.querySelector<HTMLElement>(
    ".xterm-rows:not([data-terminal-frame-overlay])",
  );
  if (rows?.textContent) {
    terminalFrameRef.current = rows.cloneNode(true) as HTMLElement;
  }
  const sourceRows = rows?.textContent ? rows : terminalFrameRef.current;
  if (!screen || !sourceRows?.textContent) {
    logTerminalPerf("terminal.frame.preserve.skipped", {
      terminalSessionId,
      hasScreen: Boolean(screen),
      rowTextLength: rows?.textContent?.length ?? 0,
    });
    return () => undefined;
  }

  const overlay = sourceRows.cloneNode(true) as HTMLElement;
  overlay.dataset.terminalFrameOverlay = "true";
  overlay.setAttribute("aria-hidden", "true");
  Object.assign(overlay.style, {
    position: "absolute",
    inset: "0",
    zIndex: "4",
    width: "100%",
    height: "100%",
    overflow: "hidden",
    pointerEvents: "none",
    backgroundColor: terminal.options.theme?.background ?? "#0b1220",
  });
  screen.appendChild(overlay);
  logTerminalPerf("terminal.frame.preserved", {
    terminalSessionId,
    rowTextLength: sourceRows.textContent.length,
  });

  return () => {
    overlay.remove();
  };
}

function releaseTerminalFrameAfterPaint(release: () => void): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(release);
  });
}

interface UseTerminalOutputStreamOptions {
  activeRef: MutableRef<boolean>;
  deferredOutputRef: MutableRef<string>;
  deferredSnapshotRef: MutableRef<string | null>;
  hasDeferredOutputRef: MutableRef<boolean>;
  hasRenderedSnapshotRef: MutableRef<boolean>;
  lastInputSentAtRef: MutableRef<number | null>;
  outputSequenceRef: MutableRef<number>;
  refreshTerminalViewportRef: MutableRef<(() => void) | null>;
  requiresSnapshotRestoreRef: MutableRef<boolean>;
  setHasNewOutputBelow: Dispatch<SetStateAction<boolean>>;
  setTerminalAtBottom: Dispatch<SetStateAction<boolean>>;
  setTmuxScrollbackActive: Dispatch<SetStateAction<boolean>>;
  terminalRef: MutableRef<Terminal | null>;
  terminalFrameRef: MutableRef<HTMLElement | null>;
  terminalSessionId: string;
  websocketContentVersionRef: MutableRef<number>;
}

export function useTerminalOutputStream({
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
}: UseTerminalOutputStreamOptions) {
  const renderTerminalSnapshot = useMemoizedFn((data: string) => {
    const nextChunk = filterBrowserHandledTerminalOutput(data);
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    setTerminalAtBottom(true);
    setHasNewOutputBelow(false);
    setTmuxScrollbackActive(false);

    logTerminalPerf("terminal.snapshot.received", {
      terminalSessionId,
      ...summarizeTerminalChunk(nextChunk),
    });

    hasRenderedSnapshotRef.current = true;
    hasDeferredOutputRef.current = false;
    deferredOutputRef.current = "";
    deferredSnapshotRef.current = null;
    requiresSnapshotRestoreRef.current = false;

    const releaseTerminalFrame = preserveTerminalFrame(
      terminal,
      terminalSessionId,
      terminalFrameRef,
    );
    terminal.reset();
    const renderStartedAt = performance.now();
    terminal.write(wrapSynchronizedOutput(nextChunk), () => {
      logTerminalPerf("terminal.snapshot.rendered", {
        terminalSessionId,
        renderDurationMs: Number(
          (performance.now() - renderStartedAt).toFixed(2),
        ),
        ...summarizeTerminalChunk(nextChunk),
      });
      terminal.scrollToBottom();
      setTerminalAtBottom(true);
      setHasNewOutputBelow(false);
      setTmuxScrollbackActive(false);
      refreshTerminalViewportRef.current?.();
      releaseTerminalFrameAfterPaint(releaseTerminalFrame);
    });
  });

  const markDeferredOutput = useMemoizedFn((data: string) => {
    hasDeferredOutputRef.current = true;

    if (requiresSnapshotRestoreRef.current) {
      return;
    }

    if (
      deferredOutputRef.current.length + data.length >
      DEFERRED_OUTPUT_REPLAY_MAX_CHARS
    ) {
      deferredOutputRef.current = "";
      deferredSnapshotRef.current = null;
      requiresSnapshotRestoreRef.current = true;
      return;
    }

    deferredOutputRef.current += data;
  });

  const replayDeferredOutput = useMemoizedFn(() => {
    const terminal = terminalRef.current;
    const deferredSnapshot = deferredSnapshotRef.current;
    const deferredOutput = deferredOutputRef.current;
    if (
      !terminal ||
      (deferredSnapshot === null && deferredOutput.length === 0)
    ) {
      return false;
    }

    deferredOutputRef.current = "";
    deferredSnapshotRef.current = null;
    hasDeferredOutputRef.current = false;

    if (deferredSnapshot !== null) {
      renderTerminalSnapshot(deferredSnapshot);
    }

    if (!deferredOutput) {
      return true;
    }

    const releaseTerminalFrame = preserveTerminalFrame(
      terminal,
      terminalSessionId,
      terminalFrameRef,
    );
    const renderStartedAt = performance.now();
    terminal.write(wrapSynchronizedOutput(deferredOutput), () => {
      logTerminalPerf("terminal.deferred-output.rendered", {
        terminalSessionId,
        renderDurationMs: Number(
          (performance.now() - renderStartedAt).toFixed(2),
        ),
        ...summarizeTerminalChunk(deferredOutput),
      });
      refreshTerminalViewportRef.current?.();
      releaseTerminalFrameAfterPaint(releaseTerminalFrame);
    });

    return true;
  });

  const onSnapshot = useMemoizedFn((data: string) => {
    websocketContentVersionRef.current += 1;
    if (!activeRef.current) {
      deferredSnapshotRef.current = data;
      deferredOutputRef.current = "";
      hasDeferredOutputRef.current = true;
      requiresSnapshotRestoreRef.current = false;
      return;
    }

    renderTerminalSnapshot(data);
  });

  const onOutput = useMemoizedFn((data: string) => {
    const nextChunk = filterBrowserHandledTerminalOutput(data);
    if (!nextChunk) {
      return;
    }
    websocketContentVersionRef.current += 1;

    const now = Date.now();
    outputSequenceRef.current += 1;
    const outputSequence = outputSequenceRef.current;
    logTerminalPerf("terminal.output.received", {
      terminalSessionId,
      seq: outputSequence,
      sinceLastInputMs:
        lastInputSentAtRef.current === null
          ? null
          : now - lastInputSentAtRef.current,
      ...summarizeTerminalChunk(nextChunk),
    });
    recordTerminalPerfProbeEvent("terminal.output.received", nextChunk, {
      terminalSessionId,
      seq: outputSequence,
      sinceLastInputMs:
        lastInputSentAtRef.current === null
          ? null
          : now - lastInputSentAtRef.current,
      ...summarizeTerminalChunk(nextChunk),
    });

    if (!activeRef.current) {
      markDeferredOutput(nextChunk);
      return;
    }

    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    const wasAtBottom = isTerminalAtBottom(terminal);
    if (!wasAtBottom) {
      setHasNewOutputBelow(true);
    }
    const renderStartedAt = performance.now();
    terminal.write(nextChunk, () => {
      const renderedAt = performance.now();
      const sinceLastInputMs =
        lastInputSentAtRef.current === null
          ? null
          : Date.now() - lastInputSentAtRef.current;
      logTerminalPerf("terminal.output.rendered", {
        terminalSessionId,
        seq: outputSequence,
        sinceLastInputMs,
        renderDurationMs: Number((renderedAt - renderStartedAt).toFixed(2)),
        ...summarizeTerminalChunk(nextChunk),
      });
      recordTerminalPerfProbeEvent("terminal.output.rendered", nextChunk, {
        terminalSessionId,
        seq: outputSequence,
        sinceLastInputMs,
        renderDurationMs: Number((renderedAt - renderStartedAt).toFixed(2)),
        ...summarizeTerminalChunk(nextChunk),
      });
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const paintDelayMs = Number(
            (performance.now() - renderedAt).toFixed(2),
          );
          const paintedSinceLastInputMs =
            lastInputSentAtRef.current === null
              ? null
              : Date.now() - lastInputSentAtRef.current;
          recordTerminalPerfProbeEvent("terminal.output.painted", nextChunk, {
            terminalSessionId,
            seq: outputSequence,
            sinceLastInputMs: paintedSinceLastInputMs,
            paintDelayMs,
            ...summarizeTerminalChunk(nextChunk),
          });
        });
      });
    });
  });

  return {
    onOutput,
    onSnapshot,
    renderTerminalSnapshot,
    replayDeferredOutput,
  };
}
