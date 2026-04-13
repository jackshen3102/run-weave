import type { Server as HttpServer } from "node:http";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type {
  TerminalClientMessage,
  TerminalServerMessage,
} from "@browser-viewer/shared";
import type { AuthService } from "../auth/service";
import { resolveTerminalFallbackLaunchConfig } from "../terminal/default-shell";
import { getLiveTerminalScrollback } from "../terminal/live-scrollback";
import type { TerminalSessionManager } from "../terminal/manager";
import { TerminalOutputBatcher } from "../terminal/output-batcher";
import {
  logTerminalPerf,
  summarizeTerminalChunk,
} from "../terminal/perf-logging";
import type { PtyService } from "../terminal/pty-service";
import type { TerminalRuntimeRegistry } from "../terminal/runtime-registry";
import { createShellPromptTracker } from "../terminal/shell-integration";
import { createTerminalRuntimeRecorder } from "../terminal/runtime-recorder";
import { createHeartbeatController } from "./heartbeat";
import { validateTerminalWebSocketHandshake } from "./terminal-handshake";

function parseTerminalClientMessage(
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
          fallback: resolveTerminalFallbackLaunchConfig({
            command: session.command,
            args: session.args,
          }),
          onFallbackActivated: (fallback) => {
            void terminalSessionManager.updateSessionLaunch(
              terminalSessionId,
              fallback,
            );
          },
        });
        runtimeRegistry.createRuntime(terminalSessionId, runtime);
        runtimeRegistry.ensureRecorder(
          terminalSessionId,
          createTerminalRuntimeRecorder(
            terminalSessionManager,
            terminalSessionId,
          ),
        );
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
      sendEvent(socket, {
        type: "error",
        message: "Terminal runtime not found",
      });
      socket.close(1011, "Terminal runtime not found");
      return;
    }

    runtimeRegistry.ensureRecorder(
      terminalSessionId,
      createTerminalRuntimeRecorder(terminalSessionManager, terminalSessionId),
    );

    const clientId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const heartbeatState = {
      heartbeatTimer: null as NodeJS.Timeout | null,
      isAlive: true,
    };
    const heartbeat = createHeartbeatController(socket, heartbeatState);
    let inputSequence = 0;
    let runtimeOutputSequence = 0;
    let flushedOutputSequence = 0;
    let lastInputAt: number | null = null;
    const outputBatcher = new TerminalOutputBatcher(
      (output) => {
        flushedOutputSequence += 1;
        logTerminalPerf("terminal.ws.output.flush", {
          terminalSessionId,
          clientId,
          seq: flushedOutputSequence,
          sinceLastInputMs: lastInputAt === null ? null : Date.now() - lastInputAt,
          ...summarizeTerminalChunk(output),
        });
        sendEvent(socket, { type: "output", data: output });
      },
      `${terminalSessionId}/${clientId}`,
    );
    let snapshotDelivered = false;
    let pendingInitialOutput = "";
    const shellPromptTracker = createShellPromptTracker({
      cwd: session?.cwd ?? null,
    });
    logTerminalPerf("terminal.ws.connected", {
      terminalSessionId,
      clientId,
      runtimeExists: Boolean(runtime),
      sessionStatus: session?.status ?? null,
    });
    runtimeRegistry.attachClient(terminalSessionId, clientId);
    const unsubscribe = runtimeRegistry.subscribe(terminalSessionId, {
      onData(data) {
        runtimeOutputSequence += 1;
        logTerminalPerf("terminal.runtime.output", {
          terminalSessionId,
          clientId,
          seq: runtimeOutputSequence,
          snapshotDelivered,
          sinceLastInputMs: lastInputAt === null ? null : Date.now() - lastInputAt,
          ...summarizeTerminalChunk(data),
        });
        const metadata = shellPromptTracker.consume(data);

        if (metadata.metadataChanged && metadata.sessionName && metadata.cwd) {
          sendEvent(socket, {
            type: "metadata",
            name: metadata.sessionName,
            cwd: metadata.cwd,
          });
        }

        if (!metadata.output) {
          return;
        }

        if (!snapshotDelivered) {
          logTerminalPerf("terminal.runtime.output.buffered-before-snapshot", {
            terminalSessionId,
            clientId,
            seq: runtimeOutputSequence,
            ...summarizeTerminalChunk(metadata.output),
          });
          pendingInitialOutput += metadata.output;
          return;
        }

        logTerminalPerf("terminal.runtime.output.to-batcher", {
          terminalSessionId,
          clientId,
          seq: runtimeOutputSequence,
          ...summarizeTerminalChunk(metadata.output),
        });
        outputBatcher.push(metadata.output);
      },
      onExit(event) {
        outputBatcher.flush();
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
      sendEvent(socket, {
        type: "snapshot",
        data: getLiveTerminalScrollback(session.scrollback),
      });
      snapshotDelivered = true;
      sendEvent(socket, {
        type: "status",
        status: session.status,
        exitCode: session.exitCode,
      });
    } else {
      sendEvent(socket, {
        type: "snapshot",
        data: "",
      });
      snapshotDelivered = true;
    }
    if (pendingInitialOutput) {
      outputBatcher.push(pendingInitialOutput);
      pendingInitialOutput = "";
    }
    heartbeat.start();

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
          inputSequence += 1;
          lastInputAt = Date.now();
          logTerminalPerf("terminal.ws.input.received", {
            terminalSessionId,
            clientId,
            seq: inputSequence,
            ...summarizeTerminalChunk(parsed.data),
          });
          outputBatcher.markNextChunkInteractive();
          const writeStartedAt = performance.now();
          runtime.write(parsed.data);
          logTerminalPerf("terminal.ws.input.written", {
            terminalSessionId,
            clientId,
            seq: inputSequence,
            runtimeWriteDurationMs: Number((performance.now() - writeStartedAt).toFixed(2)),
            ...summarizeTerminalChunk(parsed.data),
          });
        } catch (error) {
          handleRuntimeActionError(socket, terminalSessionId, "input", error);
        }
        return;
      }
      if (parsed.type === "resize") {
        try {
          runtime.resize(parsed.cols, parsed.rows);
        } catch (error) {
          handleRuntimeActionError(socket, terminalSessionId, "resize", error);
        }
        return;
      }
      if (parsed.type === "signal") {
        try {
          runtime.signal(parsed.signal);
        } catch (error) {
          handleRuntimeActionError(socket, terminalSessionId, "signal", error);
        }
        return;
      }
      const current = terminalSessionManager.getSession(terminalSessionId);
      sendEvent(socket, {
        type: "status",
        status: current?.status ?? "running",
        exitCode: current?.exitCode,
      });
    });

    let cleanedUp = false;
    const cleanupConnection = () => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      heartbeat.stop();
      unsubscribe();
      outputBatcher.dispose();
      runtimeRegistry.detachClient(terminalSessionId, clientId);
    };

    socket.on("close", () => {
      cleanupConnection();
    });

    socket.on("error", () => {
      cleanupConnection();
    });

    socket.on("pong", () => {
      heartbeat.markAlive();
    });
  });

  return wss;
}
