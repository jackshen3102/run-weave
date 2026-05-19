import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import type {
  TerminalClientMessage,
  TerminalServerMessage,
} from "@browser-viewer/shared";
import { getLiveTerminalScrollback } from "../terminal/live-scrollback";
import type { TerminalSessionManager } from "../terminal/manager";
import type { TerminalRuntimeRegistry } from "../terminal/runtime-registry";
import {
  isTmuxBackedSession,
  readTerminalScrollback,
  resolveTmuxTarget,
} from "../terminal/runtime-launcher";
import type { TmuxPaneMetadata, TmuxService } from "../terminal/tmux-service";

export function parseTerminalClientMessage(
  rawData: string,
): TerminalClientMessage | null {
  try {
    const parsed = JSON.parse(rawData) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const candidate = parsed as Record<string, unknown>;
    if (candidate.type === "input" && typeof candidate.data === "string") {
      return { type: "input", data: candidate.data };
    }
    if (
      candidate.type === "resize" &&
      typeof candidate.cols === "number" &&
      typeof candidate.rows === "number"
    ) {
      return {
        type: "resize",
        cols: candidate.cols,
        rows: candidate.rows,
      };
    }
    if (
      candidate.type === "signal" &&
      (candidate.signal === "SIGINT" ||
        candidate.signal === "SIGTERM" ||
        candidate.signal === "SIGKILL")
    ) {
      return {
        type: "signal",
        signal: candidate.signal,
      };
    }
    if (candidate.type === "request-status") {
      return { type: "request-status" };
    }
  } catch {
    return null;
  }

  return null;
}

export function sendEvent(
  socket: WebSocket,
  event: TerminalServerMessage,
): void {
  if (socket.readyState !== 1) {
    return;
  }

  socket.send(JSON.stringify(event));
}

export function shouldSendInitialSnapshot(request: IncomingMessage): boolean {
  const searchParams = new URL(request.url ?? "/", "http://localhost")
    .searchParams;
  return searchParams.get("snapshot") !== "0";
}

export function shouldSettleInitialTmuxRepaint(
  session: ReturnType<TerminalSessionManager["getSession"]>,
  tmuxService?: TmuxService,
): boolean {
  return Boolean(session && isTmuxBackedSession(session) && tmuxService);
}

async function resolveLiveScrollback(
  terminalSessionManager: TerminalSessionManager,
  terminalSessionId: string,
  fallbackScrollback: string,
  tmuxService?: TmuxService,
): Promise<string> {
  const session = terminalSessionManager.getSession(terminalSessionId);
  if (session && isTmuxBackedSession(session) && tmuxService) {
    return readTerminalScrollback(
      session,
      terminalSessionManager,
      tmuxService,
      "live",
    );
  }

  const manager = terminalSessionManager as TerminalSessionManager & {
    readLiveScrollback?: (terminalSessionId: string) => Promise<string>;
    getLiveScrollback?: (terminalSessionId: string) => string;
  };
  return (
    (await manager.readLiveScrollback?.(terminalSessionId)) ??
    manager.getLiveScrollback?.(terminalSessionId) ??
    getLiveTerminalScrollback(fallbackScrollback)
  );
}

export function resolveInitialSnapshot(
  terminalSessionManager: TerminalSessionManager,
  runtimeRegistry: TerminalRuntimeRegistry,
  terminalSessionId: string,
  fallbackScrollback: string,
  tmuxService?: TmuxService,
): Promise<string> | string {
  const session = terminalSessionManager.getSession(terminalSessionId);
  if (session && isTmuxBackedSession(session) && tmuxService) {
    return runtimeRegistry.getBufferedOutput(terminalSessionId);
  }

  return resolveLiveScrollback(
    terminalSessionManager,
    terminalSessionId,
    fallbackScrollback,
    tmuxService,
  );
}

export function getTmuxPaneMetadataReader(
  tmuxService?: TmuxService,
):
  | ((
      target: ReturnType<typeof resolveTmuxTarget>,
      shellCommand?: string,
    ) => Promise<TmuxPaneMetadata | null>)
  | null {
  const reader = (
    tmuxService as
      | {
          readPaneMetadata?: (
            target: ReturnType<typeof resolveTmuxTarget>,
            shellCommand?: string,
          ) => Promise<TmuxPaneMetadata | null>;
        }
      | undefined
  )?.readPaneMetadata;
  return reader ? reader.bind(tmuxService) : null;
}
