import type { WebSocket } from "ws";
import type { PtyRuntime } from "../terminal/pty-service";
import type { TerminalSessionManager } from "../terminal/manager";
import type { TerminalOutputBatcher } from "../terminal/output-batcher";
import {
  logTerminalPerf,
  summarizeTerminalChunk,
} from "../terminal/perf-logging";
import { logger } from "../logging";
import {
  handleRuntimeActionError,
  parseTerminalClientMessage,
  sendEvent,
  sendStatusEvent,
} from "./terminal-server-connection-helpers";

const terminalWsLogger = logger.child({ component: "terminal-ws" });

export interface TerminalClientInputState {
  lastInputAt: number | null;
  sequence: number;
}

interface TerminalInputHandlerOptions {
  clientId: string;
  inputState: TerminalClientInputState;
  outputBatcher: TerminalOutputBatcher;
  runtime: PtyRuntime;
  scheduleMetadataSync: () => void;
  socket: WebSocket;
  terminalSessionId: string;
  terminalSessionManager: TerminalSessionManager;
}

export function createTerminalInputHandler({
  clientId,
  inputState,
  outputBatcher,
  runtime,
  scheduleMetadataSync,
  socket,
  terminalSessionId,
  terminalSessionManager,
}: TerminalInputHandlerOptions): (data: string, isBinary: boolean) => void {
  return (data, isBinary) => {
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
        inputState.sequence += 1;
        inputState.lastInputAt = Date.now();
        logTerminalPerf("terminal.ws.input.received", {
          terminalSessionId,
          clientId,
          seq: inputState.sequence,
          ...summarizeTerminalChunk(parsed.data),
        });
        outputBatcher.markNextChunkInteractive();
        const writeStartedAt = performance.now();
        runtime.write(parsed.data);
        if (/[\r\n]/.test(parsed.data)) {
          scheduleMetadataSync();
        }
        logTerminalPerf("terminal.ws.input.written", {
          terminalSessionId,
          clientId,
          seq: inputState.sequence,
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
    sendStatusEvent(socket, current?.status ?? "running", current?.exitCode);
  };
}
