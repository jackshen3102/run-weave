import type { Server as HttpServer } from "node:http";
import { WebSocketServer } from "ws";
import type { AuthService } from "../auth/service";
import { logger } from "../logging";
import {
  isTunnelRequestAuthorized,
  rejectUnauthorizedTunnelUpgrade,
  type TunnelAuthConfig,
} from "../server/tunnel-auth";
import type { TerminalSessionManager } from "../terminal/manager";
import { TerminalOutputBatcher } from "../terminal/output-batcher";
import {
  logTerminalPerf,
  summarizeTerminalChunk,
} from "../terminal/perf-logging";
import type { PtyService } from "../terminal/pty-service";
import type { TerminalRuntimeRegistry } from "../terminal/runtime-registry";
import {
  ensureTerminalRuntime,
  isTmuxBackedSession,
  resolveTmuxTarget,
} from "../terminal/runtime-launcher";
import { createTerminalRuntimeRecorder } from "../terminal/runtime-recorder";
import { createShellPromptTracker } from "../terminal/shell-integration";
import type { TmuxService } from "../terminal/tmux-service";
import { createHeartbeatController } from "./heartbeat";
import { validateTerminalWebSocketHandshake } from "./terminal-handshake";
import {
  delay,
  getTmuxPaneMetadataReader,
  handleRuntimeActionError,
  parseTerminalClientMessage,
  resolveInitialSnapshot,
  sendEvent,
  sendStatusEvent,
  shouldSendInitialSnapshot,
  shouldSettleInitialTmuxRepaint,
  TMUX_INITIAL_REPAINT_SETTLE_MS,
  TMUX_METADATA_SYNC_DELAY_MS,
} from "./terminal-server-connection-helpers";

const terminalWsLogger = logger.child({ component: "terminal-ws" });

export function attachTerminalWebSocketServer(
  server: HttpServer,
  terminalSessionManager: TerminalSessionManager,
  runtimeRegistry: TerminalRuntimeRegistry,
  authService: AuthService,
  ptyService?: PtyService,
  tmuxService?: TmuxService,
  options?: {
    tunnelAuthConfig?: TunnelAuthConfig | null;
  },
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/ws/terminal") {
      return;
    }
    if (!isTunnelRequestAuthorized(request, options?.tunnelAuthConfig)) {
      rejectUnauthorizedTunnelUpgrade(socket);
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", async (socket, request) => {
    const handshake = validateTerminalWebSocketHandshake({
      request,
      authService,
      terminalSessionManager,
    });
    if (!handshake.ok) {
      terminalWsLogger.warn("terminal-ws.handshake.rejected", {
        message: "Terminal websocket handshake rejected",
        reason: handshake.closeReason,
        ...handshake.logMeta,
      });
      sendEvent(socket, { type: "error", message: handshake.errorMessage });
      socket.close(1008, handshake.closeReason);
      return;
    }

    const { terminalSessionId } = handshake;
    const connectedAt = Date.now();
    const session = terminalSessionManager.getSession(terminalSessionId);
    const sendInitialSnapshot = shouldSendInitialSnapshot(request);
    const settleInitialTmuxRepaint = shouldSettleInitialTmuxRepaint(
      session,
      tmuxService,
    );
    const pendingClientMessages: Array<{ data: string; isBinary: boolean }> =
      [];
    let handleClientMessage:
      | ((data: string, isBinary: boolean) => void)
      | null = null;
    socket.on("message", (data, isBinary) => {
      const rawData = String(data);
      if (!handleClientMessage) {
        pendingClientMessages.push({ data: rawData, isBinary });
        return;
      }

      handleClientMessage(rawData, isBinary);
    });

    let runtime = runtimeRegistry.getRuntime(terminalSessionId);
    if (
      runtime &&
      session &&
      isTmuxBackedSession(session) &&
      ptyService &&
      tmuxService &&
      runtimeRegistry.getAttachedClientCount(terminalSessionId) === 0
    ) {
      terminalWsLogger.info("terminal.tmux.attach-runtime.disposed", {
        message: "Disposed idle tmux runtime before attaching terminal websocket",
        terminalSessionId,
      });
      await runtimeRegistry.disposeRuntime(terminalSessionId);
      runtime = undefined;
    }
    if (!runtime && session?.status === "running" && ptyService) {
      try {
        const ensured = await ensureTerminalRuntime({
          session,
          terminalSessionManager,
          runtimeRegistry,
          ptyService,
          tmuxService,
        });
        runtime = ensured.runtime;
        if (ensured.warning) {
          sendEvent(socket, {
            type: "error",
            message: ensured.warning,
          });
        }
      } catch (error) {
        terminalWsLogger.error("terminal.runtime.recreate.failed", {
          message: "Failed to recreate terminal runtime",
          terminalSessionId,
          error,
        });
        sendEvent(socket, {
          type: "error",
          message: `Failed to recreate terminal runtime: ${String(error)}`,
        });
        socket.close(1011, "Failed to recreate terminal runtime");
        return;
      }
    }
    if (!runtime) {
      terminalWsLogger.error("terminal.runtime.missing", {
        message: "Terminal runtime not found",
        terminalSessionId,
        sessionStatus: session?.status ?? null,
      });
      sendEvent(socket, {
        type: "error",
        message: "Terminal runtime not found",
      });
      socket.close(1011, "Terminal runtime not found");
      return;
    }
    const activeRuntime = runtime;

    if (!session || !isTmuxBackedSession(session)) {
      runtimeRegistry.ensureRecorder(
        terminalSessionId,
        createTerminalRuntimeRecorder(
          terminalSessionManager,
          terminalSessionId,
        ),
      );
    }

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
    const outputBatcher = new TerminalOutputBatcher((output) => {
      flushedOutputSequence += 1;
      logTerminalPerf("terminal.ws.output.flush", {
        terminalSessionId,
        clientId,
        seq: flushedOutputSequence,
        sinceLastInputMs:
          lastInputAt === null ? null : Date.now() - lastInputAt,
        ...summarizeTerminalChunk(output),
      });
      sendEvent(socket, { type: "output", data: output });
    }, `${terminalSessionId}/${clientId}`);
    let snapshotDelivered = false;
    let pendingInitialOutput = "";
    const shellPromptTracker = createShellPromptTracker({
      cwd: session?.cwd ?? null,
      activeCommand: session?.activeCommand ?? null,
    });
    const tmuxPaneMetadataReader = getTmuxPaneMetadataReader(tmuxService);
    let tmuxMetadataSyncTimer: NodeJS.Timeout | null = null;
    let tmuxMetadataSyncInFlight = false;
    let shellPromptCommandActive = false;

    const publishMetadata = async (
      metadata: {
        cwd: string;
        activeCommand: string | null;
      },
      options?: { forceSend?: boolean },
    ): Promise<void> => {
      const current = terminalSessionManager.getSession(terminalSessionId);
      const metadataChanged =
        current?.cwd !== metadata.cwd ||
        current.activeCommand !== metadata.activeCommand;
      if (!metadataChanged && !options?.forceSend) {
        return;
      }

      if (metadataChanged) {
        await terminalSessionManager.updateSessionMetadata(terminalSessionId, {
          cwd: metadata.cwd,
          activeCommand: metadata.activeCommand,
        });
      }
      sendEvent(socket, {
        type: "metadata",
        cwd: metadata.cwd,
        activeCommand: metadata.activeCommand,
      });
    };

    const syncTmuxPaneMetadata = async (): Promise<void> => {
      if (
        !session ||
        !tmuxService ||
        !tmuxPaneMetadataReader ||
        !isTmuxBackedSession(session) ||
        shellPromptCommandActive ||
        tmuxMetadataSyncInFlight
      ) {
        return;
      }

      tmuxMetadataSyncInFlight = true;
      try {
        const metadata = await tmuxPaneMetadataReader(
          resolveTmuxTarget(session, tmuxService),
          session.command,
        );
        if (metadata) {
          await publishMetadata(metadata);
        }
      } catch (error) {
        terminalWsLogger.error("terminal.tmux.metadata-sync.failed", {
          message: "Tmux pane metadata sync failed",
          terminalSessionId,
          error,
        });
      } finally {
        tmuxMetadataSyncInFlight = false;
      }
    };

    const scheduleTmuxPaneMetadataSync = (
      delayMs = TMUX_METADATA_SYNC_DELAY_MS,
    ): void => {
      if (
        !session ||
        !isTmuxBackedSession(session) ||
        !tmuxPaneMetadataReader
      ) {
        return;
      }
      if (tmuxMetadataSyncTimer) {
        clearTimeout(tmuxMetadataSyncTimer);
      }
      tmuxMetadataSyncTimer = setTimeout(() => {
        tmuxMetadataSyncTimer = null;
        void syncTmuxPaneMetadata();
      }, delayMs);
    };

    logTerminalPerf("terminal.ws.connected", {
      terminalSessionId,
      clientId,
      runtimeExists: Boolean(runtime),
      sessionStatus: session?.status ?? null,
    });
    terminalWsLogger.info("terminal-ws.connected", {
      message: "Terminal websocket connected",
      terminalSessionId,
      clientId,
      runtimeKind: session && isTmuxBackedSession(session) ? "tmux" : "pty",
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
          sinceLastInputMs:
            lastInputAt === null ? null : Date.now() - lastInputAt,
          ...summarizeTerminalChunk(data),
        });
        const metadata = shellPromptTracker.consume(data);
        shellPromptCommandActive = Boolean(metadata.activeCommand);

        if (metadata.metadataChanged && metadata.cwd) {
          void publishMetadata(
            {
              cwd: metadata.cwd,
              activeCommand: metadata.activeCommand,
            },
            { forceSend: true },
          ).catch((error: unknown) => {
            terminalWsLogger.error("terminal.tmux.metadata-sync.failed", {
              message: "Terminal metadata update failed",
              terminalSessionId,
              error,
            });
          });
        }
        scheduleTmuxPaneMetadataSync();

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
        if (
          session &&
          isTmuxBackedSession(session) &&
          ptyService &&
          tmuxService
        ) {
          void (async () => {
            await runtimeRegistry.disposeRuntime(terminalSessionId);
            try {
              const ensured = await ensureTerminalRuntime({
                session,
                terminalSessionManager,
                runtimeRegistry,
                ptyService,
                tmuxService,
              });
              if (ensured.warning) {
                sendEvent(socket, {
                  type: "error",
                  message: ensured.warning,
                });
              }
              sendStatusEvent(socket, "running");
              socket.close(1012, "Terminal tmux attach reattached");
            } catch (error) {
              terminalWsLogger.error("terminal.runtime.recreate.failed", {
                message: "Failed to recover tmux terminal runtime",
                terminalSessionId,
                error,
              });
              sendEvent(socket, {
                type: "error",
                message: `Failed to recover tmux terminal runtime: ${String(error)}`,
              });
              socket.close(1011, "Failed to recover tmux terminal runtime");
            }
          })();
          return;
        }
        terminalSessionManager.markExited(terminalSessionId, event.exitCode);
        sendStatusEvent(socket, "exited", event.exitCode);
        sendEvent(socket, {
          type: "exit",
          exitCode: event.exitCode,
        });
      },
    });

    sendEvent(socket, {
      type: "connected",
      terminalSessionId,
      runtimeKind: session && isTmuxBackedSession(session) ? "tmux" : "pty",
    });
    await syncTmuxPaneMetadata();
    if (session) {
      if (sendInitialSnapshot) {
        if (settleInitialTmuxRepaint) {
          await delay(TMUX_INITIAL_REPAINT_SETTLE_MS);
        }
        sendEvent(socket, {
          type: "snapshot",
          data: await resolveInitialSnapshot(
            terminalSessionManager,
            runtimeRegistry,
            terminalSessionId,
            session.scrollback,
            tmuxService,
          ),
        });
      }
      snapshotDelivered = true;
      sendStatusEvent(socket, session.status, session.exitCode);
    } else {
      sendEvent(socket, {
        type: "snapshot",
        data: "",
      });
      snapshotDelivered = true;
    }
    if (settleInitialTmuxRepaint) {
      pendingInitialOutput = "";
    }
    if (pendingInitialOutput) {
      outputBatcher.push(pendingInitialOutput);
      pendingInitialOutput = "";
    }
    heartbeat.start();

    handleClientMessage = (data, isBinary) => {
      if (isBinary) {
        return;
      }

      const parsed = parseTerminalClientMessage(data);
      if (!parsed) {
        terminalWsLogger.warn("terminal-ws.invalid-message", {
          message: "Terminal websocket invalid message",
          terminalSessionId,
          messageLength: data.length,
        });
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
          activeRuntime.write(parsed.data);
          if (/[\r\n]/.test(parsed.data)) {
            scheduleTmuxPaneMetadataSync();
          }
          logTerminalPerf("terminal.ws.input.written", {
            terminalSessionId,
            clientId,
            seq: inputSequence,
            runtimeWriteDurationMs: Number(
              (performance.now() - writeStartedAt).toFixed(2),
            ),
            ...summarizeTerminalChunk(parsed.data),
          });
        } catch (error) {
          handleRuntimeActionError(socket, terminalSessionId, "input", error);
        }
        return;
      }
      if (parsed.type === "resize") {
        try {
          activeRuntime.resize(parsed.cols, parsed.rows);
        } catch (error) {
          handleRuntimeActionError(socket, terminalSessionId, "resize", error);
        }
        return;
      }
      if (parsed.type === "signal") {
        try {
          activeRuntime.signal(parsed.signal);
        } catch (error) {
          handleRuntimeActionError(socket, terminalSessionId, "signal", error);
        }
        return;
      }
      const current = terminalSessionManager.getSession(terminalSessionId);
      sendStatusEvent(socket, current?.status ?? "running", current?.exitCode);
    };
    for (const pendingMessage of pendingClientMessages.splice(0)) {
      handleClientMessage(pendingMessage.data, pendingMessage.isBinary);
    }

    let cleanedUp = false;
    const cleanupConnection = () => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      heartbeat.stop();
      unsubscribe();
      outputBatcher.dispose();
      if (tmuxMetadataSyncTimer) {
        clearTimeout(tmuxMetadataSyncTimer);
        tmuxMetadataSyncTimer = null;
      }
      runtimeRegistry.detachClient(terminalSessionId, clientId);
      if (
        session &&
        isTmuxBackedSession(session) &&
        runtimeRegistry.getAttachedClientCount(terminalSessionId) === 0
      ) {
        void runtimeRegistry
          .disposeRuntime(terminalSessionId)
          .catch((error: unknown) => {
            terminalWsLogger.error("terminal.tmux.attach-runtime.disposed", {
              message: "Failed to dispose idle tmux runtime",
              terminalSessionId,
              error,
            });
          });
      }
    };

    socket.on("close", (code, reason) => {
      terminalWsLogger.info("terminal-ws.closed", {
        message: "Terminal websocket closed",
        terminalSessionId,
        clientId,
        code,
        reason: String(reason),
        durationMs: Date.now() - connectedAt,
      });
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
