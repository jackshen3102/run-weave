import type { IncomingMessage } from "node:http";
import type {
  TerminalClientMessage,
  TerminalServerMessage,
} from "@runweave/shared";
import type { WebSocket } from "ws";
import { logger } from "../logging";
import { getLiveTerminalScrollback } from "../terminal/live-scrollback";
import type {
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../terminal/manager";
import type { TerminalRuntimeRegistry } from "../terminal/runtime-registry";
import type { TmuxPaneMetadata, TmuxService } from "../terminal/tmux-service";
import {
  isTmuxBackedSession,
  readTerminalScrollback,
  resolveTmuxTarget,
} from "../terminal/runtime-launcher";

export const TMUX_INITIAL_REPAINT_SETTLE_MS = 50;
export const TMUX_METADATA_SYNC_DELAY_MS = 100;
const terminalWsLogger = logger.child({ component: "terminal-ws" });

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

export function sendStatusEvent(
  socket: WebSocket,
  status: TerminalSessionRecord["status"],
  exitCode?: number,
): void {
  sendEvent(socket, {
    type: "status",
    status,
    exitCode,
  });
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

export async function resolveLiveScrollback(
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

export function handleRuntimeActionError(
  socket: WebSocket,
  terminalSessionId: string,
  action: "input" | "resize" | "signal",
  error: unknown,
): void {
  terminalWsLogger.error("terminal.input.failed", {
    message: "Terminal runtime action failed",
    terminalSessionId,
    action,
    error,
  });
  sendEvent(socket, {
    type: "error",
    message: `Terminal ${action} failed: ${String(error)}`,
  });
}
