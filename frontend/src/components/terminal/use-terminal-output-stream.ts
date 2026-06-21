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
  BELL_CHARACTER,
  DEFERRED_OUTPUT_REPLAY_MAX_CHARS,
  recordTerminalPerfProbeEvent,
} from "./terminal-surface-utils";

type MutableRef<T> = {
  current: T;
};

interface UseTerminalOutputStreamOptions {
  activeRef: MutableRef<boolean>;
  deferredOutputRef: MutableRef<string>;
  hasDeferredOutputRef: MutableRef<boolean>;
  hasRenderedSnapshotRef: MutableRef<boolean>;
  lastInputSentAtRef: MutableRef<number | null>;
  onBellRef: MutableRef<(() => void) | undefined>;
  outputSequenceRef: MutableRef<number>;
  refreshTerminalViewportRef: MutableRef<(() => void) | null>;
  requiresSnapshotRestoreRef: MutableRef<boolean>;
  setHasNewOutputBelow: Dispatch<SetStateAction<boolean>>;
  setTerminalAtBottom: Dispatch<SetStateAction<boolean>>;
  setTmuxScrollbackActive: Dispatch<SetStateAction<boolean>>;
  terminalRef: MutableRef<Terminal | null>;
  terminalSessionId: string;
  websocketContentVersionRef: MutableRef<number>;
}

export function useTerminalOutputStream({
  activeRef,
  deferredOutputRef,
  hasDeferredOutputRef,
  hasRenderedSnapshotRef,
  lastInputSentAtRef,
  onBellRef,
  outputSequenceRef,
  refreshTerminalViewportRef,
  requiresSnapshotRestoreRef,
  setHasNewOutputBelow,
  setTerminalAtBottom,
  setTmuxScrollbackActive,
  terminalRef,
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
    requiresSnapshotRestoreRef.current = false;
    terminal.reset();
    if (!nextChunk) {
      refreshTerminalViewportRef.current?.();
      return;
    }

    const renderStartedAt = performance.now();
    terminal.write(nextChunk, () => {
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
      requiresSnapshotRestoreRef.current = true;
      return;
    }

    deferredOutputRef.current += data;
  });

  const replayDeferredOutput = useMemoizedFn(() => {
    const terminal = terminalRef.current;
    const deferredOutput = deferredOutputRef.current;
    if (!terminal || !deferredOutput) {
      return false;
    }

    deferredOutputRef.current = "";
    hasDeferredOutputRef.current = false;

    const renderStartedAt = performance.now();
    terminal.write(deferredOutput, () => {
      logTerminalPerf("terminal.deferred-output.rendered", {
        terminalSessionId,
        renderDurationMs: Number(
          (performance.now() - renderStartedAt).toFixed(2),
        ),
        ...summarizeTerminalChunk(deferredOutput),
      });
      refreshTerminalViewportRef.current?.();
    });

    return true;
  });

  const onSnapshot = useMemoizedFn((data: string) => {
    websocketContentVersionRef.current += 1;
    if (!activeRef.current) {
      if (terminalRef.current) {
        renderTerminalSnapshot(data);
        return;
      }
      if (data.length > 0) {
        hasDeferredOutputRef.current = true;
        deferredOutputRef.current = "";
        requiresSnapshotRestoreRef.current = true;
      }
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
    if (!activeRef.current && nextChunk.includes(BELL_CHARACTER)) {
      onBellRef.current?.();
    }

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

    const terminal = terminalRef.current;
    if (!activeRef.current) {
      if (
        terminal &&
        hasRenderedSnapshotRef.current &&
        !hasDeferredOutputRef.current &&
        !requiresSnapshotRestoreRef.current
      ) {
        const renderStartedAt = performance.now();
        terminal.write(nextChunk, () => {
          logTerminalPerf("terminal.background-output.rendered", {
            terminalSessionId,
            seq: outputSequence,
            renderDurationMs: Number(
              (performance.now() - renderStartedAt).toFixed(2),
            ),
            ...summarizeTerminalChunk(nextChunk),
          });
        });
        return;
      }
      markDeferredOutput(nextChunk);
      return;
    }

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
