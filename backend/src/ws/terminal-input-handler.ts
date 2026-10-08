import type { TmuxService } from "../terminal/tmux/service";
import { resolveTmuxTarget } from "../terminal/runtime/launcher";
import type { WebSocket } from "ws";
import type { PtyRuntime } from "../terminal/runtime/pty-service";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import { beginTerminalInput, queueBehindTextAttachment } from "../terminal/runtime/input-admission";
import { rawTerminalInputIntent } from "../terminal/runtime/input-intent";
import type { TerminalOutputBatcher } from "../terminal/runtime/output-batcher";
import {
  logTerminalPerf,
  summarizeTerminalChunk,
} from "../terminal/runtime/perf-logging";
import { logger } from "../logging/index";
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
  tmuxService?: TmuxService;
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
  tmuxService,
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
        const intent = rawTerminalInputIntent(parsed.data);
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
        const session = terminalSessionManager.getSession(terminalSessionId);
        if (!session) throw new Error("Terminal session is unavailable");
        const panelId = terminalSessionManager.getPanelWorkspace(session.id)?.activePanelId;
        const panel = panelId ? terminalSessionManager.getPanel(panelId) : undefined;
        const pane = panel && tmuxService ? { ...resolveTmuxTarget(session, tmuxService), paneId: panel.tmuxPaneId } : null;
        const queued = queueBehindTextAttachment(session, async () => {
          if (terminalSessionManager.getSession(session.id) !== session || session.status !== "running") throw new Error("Terminal target exited; queued input was not written");
          if (pane && tmuxService) {
            if (terminalSessionManager.getPanel(panel!.id) !== panel || panel!.status !== "running") throw new Error("Terminal panel exited; queued input was not written");
            await tmuxService.sendKeySequence(pane, [{ type: "literal", value: parsed.data }]);
          } else runtime.write(parsed.data);
        }, panel?.tmuxPaneId ?? null, intent);
        if (queued) {
          void queued.catch((error) => handleRuntimeActionError(socket, terminalSessionId, "input", error));
        } else {
          const release = beginTerminalInput(session, panel?.tmuxPaneId ?? null, intent);
          try { runtime.write(parsed.data); } finally { release(); }
        }
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
        const session = terminalSessionManager.getSession(terminalSessionId);
        if (!session) throw new Error("Terminal session is unavailable");
        const activeId = terminalSessionManager.getPanelWorkspace(session.id)?.activePanelId;
        const release = beginTerminalInput(session, activeId ? terminalSessionManager.getPanel(activeId)?.tmuxPaneId ?? null : null, { kind: "interrupt", source: "signal" });
        try {
          runtime.signal(parsed.signal);
        } finally {
          release();
        }
      } catch (error) {
        handleRuntimeActionError(socket, terminalSessionId, "signal", error);
      }
      return;
    }
    const current = terminalSessionManager.getSession(terminalSessionId);
    sendStatusEvent(socket, current?.status ?? "running", current?.exitCode);
  };
}
