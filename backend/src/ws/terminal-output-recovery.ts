import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import type {
  TerminalOutputCursor,
  TerminalRecoveryReason,
} from "@runweave/shared/terminal/websocket";
import type { TerminalRuntimeRegistry } from "../terminal/runtime/registry";
import type { TerminalOutputBatcher } from "../terminal/runtime/output-batcher";
import type { TerminalOutputFrame } from "../terminal/runtime/output-recovery";
import {
  closeSlowTerminalSocket,
  sendEvent,
} from "./terminal-server-connection-helpers";

export function createTerminalOutputRecovery(options: {
  request: IncomingMessage;
  socket: WebSocket;
  registry: TerminalRuntimeRegistry;
  terminalSessionId: string;
  runtimeId?: string;
  batcher: TerminalOutputBatcher;
  includeSnapshot: boolean;
}) {
  const {
    request,
    socket,
    registry,
    terminalSessionId,
    batcher,
    includeSnapshot,
  } = options;
  const runtimeId = options.runtimeId ?? terminalSessionId;
  const buffer = registry.getOutputRecovery(runtimeId);
  const screen = registry.getOutputScreen(runtimeId);
  if (!buffer || !screen) return undefined;
  let grid = registry.getRuntime(runtimeId)?.hosted?.grid;
  let gridRevision = 0;
  let ready = false;
  const pending: TerminalOutputFrame[] = [];
  let pendingBytes = 0;
  let disposed = false;
  let releaseLease: (() => void) | undefined;
  const params = new URL(request.url ?? "/", "http://localhost").searchParams;
  const orderedResize = params.get("resizeMode") === "ordered";
  const requestedId = params.get("resumeClientId");
  const clientId =
    requestedId && /^[a-zA-Z0-9_-]{16,128}$/.test(requestedId)
      ? requestedId
      : undefined;
  const streamId = params.get("resumeStreamId");
  const offset = params.get("resumeOffset");
  const cursor: TerminalOutputCursor | undefined =
    streamId && offset !== null
      ? { streamId, offset: /^\d+$/.test(offset) ? Number(offset) : NaN }
      : undefined;

  return {
    onFrame(frame: TerminalOutputFrame) {
      if (ready && !disposed) batcher.pushFrame(frame);
      else if (!disposed) {
        pendingBytes += Buffer.byteLength(frame.data);
        if (pendingBytes > 1024 * 1024 || pending.length >= 8192) {
          disposed = true;
          closeSlowTerminalSocket(socket, "Terminal recovery queue exceeded");
        } else pending.push(frame);
      }
    },
    onResize(cols: number, rows: number) {
      if (grid) {
        if (grid.cols !== cols || grid.rows !== rows) gridRevision++;
        grid = { cols, rows };
      }
      if (!ready || disposed || !orderedResize) return;
      batcher.flush();
      sendEvent(socket, { type: "resize", cols, rows, cursor: buffer.cursor });
    },
    dispose() {
      disposed = true;
      ready = false;
      releaseLease?.();
    },
    async start(): Promise<void> {
      try {
        let capturedGridRevision = gridRevision;
        let reason: TerminalRecoveryReason = cursor
          ? "cursor_missing"
          : "initial";
        let replay = cursor ? await buffer.read(cursor) : undefined;
        if (replay && !replay.ok) reason = replay.reason;
        else if (cursor) {
          const leaseReason = clientId
            ? registry.outputClients.reason(runtimeId, clientId)
            : "client_lease_missing";
          if (leaseReason) {
            reason = leaseReason;
            replay = undefined;
          }
        }
        const resume = includeSnapshot && Boolean(replay?.ok);
        if (resume) reason = "cursor_valid";
        if (clientId)
          releaseLease = registry.outputClients.claim(
            runtimeId,
            clientId,
            resume,
            () =>
              closeSlowTerminalSocket(socket, "Terminal connection superseded"),
          );
        sendEvent(socket, {
          type: "connected",
          terminalSessionId,
          runtimeKind: registry.getRuntime(runtimeId)?.hosted ? "pty" : "tmux",
          tmuxScrollMode: registry.getRuntime(runtimeId)?.hosted ? undefined : "single-row",
          resizeMode: orderedResize ? "ordered" : undefined,
          recovery: includeSnapshot
            ? { mode: resume ? "resume" : "snapshot", reason }
            : undefined,
        });
        let head = buffer.cursor;
        if (resume && cursor) head = cursor;
        else if (includeSnapshot) {
          const snapshot = await screen.snapshot();
          if (disposed || socket.readyState !== 1) return;
          if (grid && (snapshot.cols !== grid.cols || snapshot.rows !== grid.rows)) throw new Error("Snapshot grid changed");
          capturedGridRevision = gridRevision;
          if (
            !sendEvent(socket, {
              type: "snapshot",
              ...snapshot,
              modes: {
                bracketedPasteMode:
                  registry.getBracketedPasteMode(runtimeId),
              },
            })
          )
            return;
          head = snapshot.cursor;
        }
        if (disposed || socket.readyState !== 1) return;
        // The Host read is asynchronous. Queue live frames until its captured boundary arrives.
        const tail = await buffer.read(head);
        if (disposed || socket.readyState !== 1) return;
        if (capturedGridRevision !== gridRevision) throw new Error("Terminal grid changed during recovery");
        if (!tail.ok) throw new Error("Snapshot output boundary evicted");
        for (const frame of tail.frames) {
          if (
            !sendEvent(socket, {
              type: "output",
              data: frame.data,
              range: frame.range,
            })
          )
            return;
        }
        for (const frame of pending.splice(0)) {
          if (frame.range.toOffset <= tail.cursor.offset) continue;
          if (!sendEvent(socket, { type: "output", data: frame.data, range: frame.range })) return;
        }
        pendingBytes = 0;
        ready = true;
      } catch {
        closeSlowTerminalSocket(
          socket,
          "Terminal recovery unavailable; reconnect",
        );
      }
    },
  };
}
