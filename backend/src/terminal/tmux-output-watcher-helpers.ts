import { StringDecoder } from "node:string_decoder";
import type { TerminalSessionRecord } from "./manager";
import { createTerminalRuntimeRecorder } from "./runtime-recorder";
import type { ScrollbackBuffer } from "./scrollback-buffer";
import type { TmuxPaneTarget, TmuxService, TmuxTarget } from "./tmux-service";

const PANE_OUTPUT_BOUNDARY_POLL_INTERVAL_MS = 10;

export interface WatchedTmuxPane {
  decoder: StringDecoder;
  filePath: string;
  generation: number;
  offset: number;
  outputBuffer: ScrollbackBuffer;
  polling: Promise<boolean> | null;
  recordSessionOutput: boolean;
  reconcileSessionLifecycle: boolean;
  recorder: ReturnType<typeof createTerminalRuntimeRecorder>;
  target: TmuxPaneTarget;
  terminalSessionId: string;
}

export function shouldWatchSession(
  session: Pick<TerminalSessionRecord, "runtimeKind" | "status">,
): boolean {
  return session.runtimeKind === "tmux" && session.status === "running";
}

export function isInteractiveShellLaunch(
  command: string,
  args: string[],
): boolean {
  const commandName = command.split(/[\\/]/).at(-1) ?? command;
  if (!["bash", "zsh", "sh", "fish"].includes(commandName)) {
    return false;
  }
  return !args.some((arg) => arg === "-c" || arg === "-lc");
}

export function resolveTmuxTarget(
  session: TerminalSessionRecord,
  tmuxService: TmuxService,
): TmuxTarget {
  return {
    sessionName:
      session.tmuxSessionName ?? tmuxService.buildSessionName(session.id),
    socketPath: session.tmuxSocketPath ?? tmuxService.socketPath,
  };
}

export function resolvePaneWatcherKey(
  terminalSessionId: string,
  paneId: string,
): string {
  return `${terminalSessionId}\u0000${paneId}`;
}

export function isSameTmuxSessionTarget(
  left: TmuxTarget,
  right: TmuxTarget,
): boolean {
  return (
    left.sessionName === right.sessionName &&
    left.socketPath === right.socketPath
  );
}

export function isSamePaneTarget(
  left: TmuxPaneTarget,
  right: TmuxPaneTarget,
): boolean {
  return left.paneId === right.paneId && isSameTmuxSessionTarget(left, right);
}

export function sanitizeOutputPathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "-");
}

export function findScrollbackBufferPositionAfterMarker(
  buffer: ScrollbackBuffer,
  startSequence: number,
  marker: string,
): { sequence: number; offset: number } | null {
  const firstAvailableSequence =
    buffer.chunks[0]?.sequence ?? buffer.nextSequence;
  if (
    startSequence < firstAvailableSequence ||
    startSequence > buffer.nextSequence
  ) {
    return null;
  }
  const chunks = buffer.chunks.filter(
    (chunk) => chunk.sequence >= startSequence,
  );
  const output = chunks.map((chunk) => chunk.text).join("");
  const markerIndex = output.indexOf(marker);
  if (markerIndex < 0) {
    return null;
  }
  let remaining = markerIndex + marker.length;
  for (const chunk of chunks) {
    if (remaining <= chunk.text.length) {
      return { sequence: chunk.sequence, offset: remaining };
    }
    remaining -= chunk.text.length;
  }
  return null;
}

export function readScrollbackBufferFromPosition(
  buffer: ScrollbackBuffer,
  sequence: number,
  offset: number,
): string | null {
  const firstAvailableSequence =
    buffer.chunks[0]?.sequence ?? buffer.nextSequence;
  if (sequence < firstAvailableSequence || sequence > buffer.nextSequence) {
    return null;
  }
  const chunks = buffer.chunks.filter((chunk) => chunk.sequence >= sequence);
  if (chunks.length === 0) {
    return offset === 0 ? "" : null;
  }
  if (chunks[0]!.sequence !== sequence || offset > chunks[0]!.text.length) {
    return null;
  }
  return chunks
    .map((chunk, index) =>
      index === 0 ? chunk.text.slice(offset) : chunk.text,
    )
    .join("");
}

export function waitForPaneOutputBoundary(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, PANE_OUTPUT_BOUNDARY_POLL_INTERVAL_MS);
  });
}
