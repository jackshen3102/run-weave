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
  const buffer = registry.getOutputRecovery(terminalSessionId);
  const screen = registry.getOutputScreen(terminalSessionId);
  if (!buffer || !screen) return undefined;
  let ready = false;
  let disposed = false;
  let releaseLease: (() => void) | undefined;
  const params = new URL(request.url ?? "/", "http://localhost").searchParams;
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
    },
    dispose() {
      disposed = true;
      ready = false;
      releaseLease?.();
    },
    async start(): Promise<void> {
      try {
        let reason: TerminalRecoveryReason = cursor
          ? "cursor_missing"
          : "initial";
        let replay = cursor ? buffer.read(cursor) : undefined;
        if (replay && !replay.ok) reason = replay.reason;
        else if (cursor) {
          const leaseReason = clientId
            ? registry.outputClients.reason(terminalSessionId, clientId)
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
            terminalSessionId,
            clientId,
            resume,
            () =>
              closeSlowTerminalSocket(socket, "Terminal connection superseded"),
          );
        sendEvent(socket, {
          type: "connected",
          terminalSessionId,
          runtimeKind: "tmux",
          recovery: includeSnapshot
            ? { mode: resume ? "resume" : "snapshot", reason }
            : undefined,
        });
        let head = buffer.cursor;
        if (resume && cursor) head = cursor;
        else if (includeSnapshot) {
          const snapshot = await screen.snapshot();
          if (disposed || socket.readyState !== 1) return;
          if (
            !sendEvent(socket, {
              type: "snapshot",
              ...snapshot,
              modes: {
                bracketedPasteMode:
                  registry.getBracketedPasteMode(terminalSessionId),
              },
            })
          )
            return;
          head = snapshot.cursor;
        }
        if (disposed || socket.readyState !== 1) return;
        // No await between reading the captured boundary and opening live delivery.
        // Output arriving during snapshot work is recovered from the bounded ring.
        const tail = buffer.read(head);
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
