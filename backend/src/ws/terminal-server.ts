import type { Server as HttpServer } from "node:http";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type {
  TerminalClientMessage,
  TerminalServerMessage,
} from "@browser-viewer/shared";
import type { AuthService } from "../auth/service";
import type { TerminalSessionManager } from "../terminal/manager";
import type { PtyService } from "../terminal/pty-service";
import type { TerminalRuntimeRegistry } from "../terminal/runtime-registry";
import { validateTerminalWebSocketHandshake } from "./terminal-handshake";

function parseTerminalClientMessage(rawData: string): TerminalClientMessage | null {
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

function sendEvent(socket: WebSocket, event: TerminalServerMessage): void {
  if (socket.readyState !== 1) {
    return;
  }

  socket.send(JSON.stringify(event));
}

function handleRuntimeActionError(
  socket: WebSocket,
  terminalSessionId: string,
  action: "input" | "resize" | "signal",
  error: unknown,
): void {
  console.error("[viewer-be] terminal runtime action failed", {
    terminalSessionId,
    action,
    error: String(error),
  });
  sendEvent(socket, {
    type: "error",
    message: `Terminal ${action} failed: ${String(error)}`,
  });
}

export function attachTerminalWebSocketServer(
  server: HttpServer,
  terminalSessionManager: TerminalSessionManager,
  runtimeRegistry: TerminalRuntimeRegistry,
  authService: AuthService,
  ptyService?: PtyService,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/ws/terminal") {
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (socket, request) => {
    const handshake = validateTerminalWebSocketHandshake({
      request,
      authService,
      terminalSessionManager,
    });
    if (!handshake.ok) {
      sendEvent(socket, { type: "error", message: handshake.errorMessage });
      socket.close(1008, handshake.closeReason);
      return;
    }

    const { terminalSessionId } = handshake;
    const session = terminalSessionManager.getSession(terminalSessionId);
    let runtime = runtimeRegistry.getRuntime(terminalSessionId);
    if (!runtime && session?.status === "running" && ptyService) {
      try {
        runtime = ptyService.spawnSession({
          command: session.command,
          args: session.args,
          cwd: session.cwd,
        });
        runtimeRegistry.createRuntime(terminalSessionId, runtime);
      } catch (error) {
        sendEvent(socket, {
          type: "error",
          message: `Failed to recreate terminal runtime: ${String(error)}`,
        });
        socket.close(1011, "Failed to recreate terminal runtime");
        return;
      }
    }
    if (!runtime) {
      sendEvent(socket, { type: "error", message: "Terminal runtime not found" });
      socket.close(1011, "Terminal runtime not found");
      return;
    }

    const clientId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    runtimeRegistry.attachClient(terminalSessionId, clientId);
    const unsubscribe = runtimeRegistry.subscribe(terminalSessionId, {
      onData(data) {
        terminalSessionManager.appendOutput(terminalSessionId, data);
        terminalSessionManager.markActivity(terminalSessionId);
        sendEvent(socket, { type: "output", data });
      },
      onExit(event) {
        terminalSessionManager.markExited(terminalSessionId, event.exitCode);
        sendEvent(socket, {
          type: "status",
          status: "exited",
          exitCode: event.exitCode,
        });
        sendEvent(socket, {
          type: "exit",
          exitCode: event.exitCode,
        });
      },
    });

    sendEvent(socket, { type: "connected", terminalSessionId });
    if (session) {
      if (session.scrollback) {
        sendEvent(socket, {
          type: "output",
          data: session.scrollback,
        });
      }
      sendEvent(socket, {
        type: "status",
        status: session.status,
        exitCode: session.exitCode,
      });
    }

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        return;
      }

      const parsed = parseTerminalClientMessage(String(data));
      if (!parsed) {
        sendEvent(socket, { type: "error", message: "Invalid message" });
        return;
      }

      if (parsed.type === "input") {
        try {
          runtime.write(parsed.data);
          terminalSessionManager.markActivity(terminalSessionId);
        } catch (error) {
          handleRuntimeActionError(socket, terminalSessionId, "input", error);
        }
        return;
      }
      if (parsed.type === "resize") {
        try {
          runtime.resize(parsed.cols, parsed.rows);
          terminalSessionManager.markActivity(terminalSessionId);
        } catch (error) {
          handleRuntimeActionError(socket, terminalSessionId, "resize", error);
        }
        return;
      }
      if (parsed.type === "signal") {
        try {
          runtime.signal(parsed.signal);
          terminalSessionManager.markActivity(terminalSessionId);
        } catch (error) {
          handleRuntimeActionError(socket, terminalSessionId, "signal", error);
        }
        return;
      }
      terminalSessionManager.markActivity(terminalSessionId);
      const current = terminalSessionManager.getSession(terminalSessionId);
      sendEvent(socket, {
        type: "status",
        status: current?.status ?? "running",
        exitCode: current?.exitCode,
      });
    });

    socket.on("close", () => {
      unsubscribe();
      runtimeRegistry.detachClient(terminalSessionId, clientId);
    });
  });

  return wss;
}
