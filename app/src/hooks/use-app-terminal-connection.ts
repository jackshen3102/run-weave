import { useCallback, useEffect, useRef, useState } from "react";
import type {
  TerminalClientMessage,
  TerminalServerMessage,
  TerminalSignal,
  TerminalSessionStatusResponse,
} from "@browser-viewer/shared";
import type { TerminalRendererHandle } from "@browser-viewer/terminal-renderer";

import { recordSupportLog } from "../features/support-logs";
import { ApiError } from "../services/http";
import {
  createTerminalWsTicket,
  getTerminalSession,
} from "../services/terminal";

type ConnectionStatus = "connecting" | "connected" | "closed";
type RuntimeStatus = "running" | "exited" | null;

interface TerminalMetadata {
  cwd: string;
  command: string;
  activeCommand: string | null;
  projectId: string | null;
  lastActivityAt: string;
  status: "running" | "exited";
}

const MAX_PENDING_INPUT_CHARS = 8 * 1024;

type TerminalMessageCounts = Partial<Record<TerminalServerMessage["type"], number>>;

function toWebSocketBase(apiBase: string): string {
  const base =
    apiBase ||
    (typeof window !== "undefined"
      ? `${window.location.protocol}//${window.location.host}`
      : "");
  if (base.startsWith("https://")) {
    return `wss://${base.slice("https://".length).replace(/\/+$/, "")}`;
  }
  if (base.startsWith("http://")) {
    return `ws://${base.slice("http://".length).replace(/\/+$/, "")}`;
  }
  if (typeof window !== "undefined") {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}`;
  }
  return base.replace(/\/+$/, "");
}

function buildTerminalWsUrl(
  apiBase: string,
  terminalSessionId: string,
  ticket: string,
): string {
  const searchParams = new URLSearchParams({
    terminalSessionId,
    token: ticket,
  });
  return `${toWebSocketBase(apiBase)}/ws/terminal?${searchParams.toString()}`;
}

function sendMessage(
  socket: WebSocket | null,
  payload: TerminalClientMessage,
): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(payload));
}

function toTerminalMetadata(
  session: TerminalSessionStatusResponse,
): TerminalMetadata {
  return {
    cwd: session.cwd,
    command: session.command,
    activeCommand: session.activeCommand,
    projectId: session.projectId,
    lastActivityAt: session.lastActivityAt,
    status: session.status,
  };
}

export function useAppTerminalConnection({
  apiBase,
  accessToken,
  terminalSessionId,
  rendererRef,
  onAuthExpired,
}: {
  apiBase: string;
  accessToken: string;
  terminalSessionId: string;
  rendererRef: React.RefObject<TerminalRendererHandle | null>;
  onAuthExpired: () => void;
}) {
  const socketRef = useRef<WebSocket | null>(null);
  const pendingInputRef = useRef<string[]>([]);
  const pendingResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const messageCountsRef = useRef<TerminalMessageCounts>({});
  const reconnectTimerRef = useRef<number | null>(null);
  const tokenRef = useRef(accessToken);
  const runtimeStatusRef = useRef<RuntimeStatus>(null);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus>(null);
  const [metadata, setMetadata] = useState<TerminalMetadata | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    tokenRef.current = accessToken;
  }, [accessToken]);

  const setNextRuntimeStatus = useCallback((status: RuntimeStatus) => {
    runtimeStatusRef.current = status;
    setRuntimeStatus(status);
  }, []);

  useEffect(() => {
    let cancelled = false;

    void getTerminalSession(apiBase, accessToken, terminalSessionId)
      .then((session) => {
        if (cancelled) {
          return;
        }
        setMetadata(toTerminalMetadata(session));
        setNextRuntimeStatus(session.status);
        if (session.scrollback) {
          rendererRef.current?.resetAndWrite(session.scrollback);
        }
      })
      .catch((nextError: unknown) => {
        if (cancelled) {
          return;
        }
        if (nextError instanceof ApiError && nextError.status === 401) {
          onAuthExpired();
          return;
        }
        if (nextError instanceof ApiError && nextError.status === 404) {
          setNotFound(true);
          setError("终端不存在或已被删除");
          return;
        }
        setError(nextError instanceof Error ? nextError.message : "加载失败");
      });

    return () => {
      cancelled = true;
    };
  }, [
    accessToken,
    apiBase,
    onAuthExpired,
    rendererRef,
    setNextRuntimeStatus,
    terminalSessionId,
  ]);

  useEffect(() => {
    let cancelled = false;

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const incrementMessageCount = (type: TerminalServerMessage["type"]) => {
      messageCountsRef.current = {
        ...messageCountsRef.current,
        [type]: (messageCountsRef.current[type] ?? 0) + 1,
      };
    };

    const flushPendingInput = (socket: WebSocket) => {
      const pendingInput = pendingInputRef.current.splice(0);
      for (const data of pendingInput) {
        sendMessage(socket, { type: "input", data });
      }
      if (pendingInput.length > 0) {
        recordSupportLog("terminal.ws.input.flushed", {
          terminalSessionId,
          pendingInputCount: pendingInput.length,
          pendingInputLength: pendingInput.reduce(
            (total, data) => total + data.length,
            0,
          ),
        });
      }
    };

    const scheduleReconnect = () => {
      clearReconnectTimer();
      recordSupportLog("terminal.ws.reconnect_scheduled", {
        terminalSessionId,
        delayMs: 1200,
      });
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        void connect();
      }, 1200);
    };

    const connect = async () => {
      if (cancelled) {
        return;
      }
      setConnectionStatus("connecting");
      setError(null);
      recordSupportLog("terminal.ws.connecting", {
        terminalSessionId,
        pendingInputCount: pendingInputRef.current.length,
      });
      try {
        recordSupportLog("terminal.ws.ticket.request_started", {
          terminalSessionId,
        });
        const ticketPayload = await createTerminalWsTicket(
          apiBase,
          tokenRef.current,
          terminalSessionId,
        );
        if (cancelled) {
          return;
        }
        recordSupportLog("terminal.ws.ticket.request_completed", {
          terminalSessionId,
        });

        const socket = new WebSocket(
          buildTerminalWsUrl(apiBase, terminalSessionId, ticketPayload.ticket),
        );
        socketRef.current = socket;

        socket.addEventListener("open", () => {
          if (socketRef.current !== socket) {
            return;
          }
          setConnectionStatus("connected");
          recordSupportLog("terminal.ws.opened", {
            terminalSessionId,
            pendingInputCount: pendingInputRef.current.length,
          });
          if (pendingResizeRef.current) {
            sendMessage(socket, {
              type: "resize",
              cols: pendingResizeRef.current.cols,
              rows: pendingResizeRef.current.rows,
            });
          }
          flushPendingInput(socket);
        });

        socket.addEventListener("message", (event) => {
          if (socketRef.current !== socket || typeof event.data !== "string") {
            return;
          }
          const message = JSON.parse(event.data) as TerminalServerMessage;
          incrementMessageCount(message.type);
          if (message.type === "snapshot") {
            rendererRef.current?.resetAndWrite(message.data);
            return;
          }
          if (message.type === "output") {
            rendererRef.current?.write(message.data);
            return;
          }
          if (message.type === "metadata") {
            setMetadata((current) =>
              current
                ? {
                    ...current,
                    cwd: message.cwd,
                    activeCommand: message.activeCommand,
                    projectId: current.projectId,
                  }
                : {
                    cwd: message.cwd,
                    command: "",
                    activeCommand: message.activeCommand,
                    projectId: null,
                    lastActivityAt: new Date().toISOString(),
                    status: "running",
                  },
            );
            return;
          }
          if (message.type === "status") {
            setNextRuntimeStatus(message.status);
            setMetadata((current) =>
              current ? { ...current, status: message.status } : current,
            );
            return;
          }
          if (message.type === "exit") {
            setNextRuntimeStatus("exited");
            setMetadata((current) =>
              current ? { ...current, status: "exited" } : current,
            );
            return;
          }
          if (message.type === "error") {
            setError(message.message);
          }
        });

        socket.addEventListener("close", (event) => {
          if (socketRef.current !== socket) {
            return;
          }
          socketRef.current = null;
          recordSupportLog("terminal.ws.closed", {
            terminalSessionId,
            code: event.code,
            wasClean: event.wasClean,
            messageCounts: messageCountsRef.current,
            pendingInputCount: pendingInputRef.current.length,
          }, event.code === 1000 ? "info" : "warn");
          messageCountsRef.current = {};
          if (event.code === 1008 && event.reason === "Unauthorized") {
            setConnectionStatus("closed");
            onAuthExpired();
            return;
          }
          setConnectionStatus("closed");
          if (!cancelled && runtimeStatusRef.current !== "exited") {
            scheduleReconnect();
          }
        });

        socket.addEventListener("error", () => {
          if (socketRef.current === socket) {
            recordSupportLog("terminal.ws.error", {
              terminalSessionId,
              pendingInputCount: pendingInputRef.current.length,
            }, "warn");
            setError("终端连接失败");
          }
        });
      } catch (nextError) {
        if (nextError instanceof ApiError && nextError.status === 401) {
          recordSupportLog("terminal.ws.ticket.unauthorized", {
            terminalSessionId,
          }, "warn");
          onAuthExpired();
          return;
        }
        if (nextError instanceof ApiError && nextError.status === 404) {
          recordSupportLog("terminal.ws.ticket.not_found", {
            terminalSessionId,
          }, "warn");
          setNotFound(true);
          setError("终端不存在或已被删除");
          return;
        }
        recordSupportLog("terminal.ws.ticket.request_failed", {
          terminalSessionId,
          error: nextError instanceof Error ? nextError.message : String(nextError),
        }, "warn");
        setConnectionStatus("closed");
        setError(nextError instanceof Error ? nextError.message : "连接失败");
        if (!cancelled) {
          scheduleReconnect();
        }
      }
    };

    void connect();
    return () => {
      cancelled = true;
      clearReconnectTimer();
      socketRef.current?.close(1000, "AppTerminalPage unmounted");
      socketRef.current = null;
    };
  }, [
    apiBase,
    onAuthExpired,
    rendererRef,
    setNextRuntimeStatus,
    terminalSessionId,
  ]);

  const sendInput = useCallback((data: string) => {
    if (!data) {
      return;
    }
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      sendMessage(socket, { type: "input", data });
      recordSupportLog("terminal.ws.input.sent", {
        terminalSessionId,
        length: data.length,
      });
      return;
    }

    const currentLength = pendingInputRef.current.reduce(
      (total, chunk) => total + chunk.length,
      0,
    );
    if (currentLength + data.length <= MAX_PENDING_INPUT_CHARS) {
      pendingInputRef.current.push(data);
      recordSupportLog("terminal.ws.input.queued", {
        terminalSessionId,
        length: data.length,
        pendingInputCount: pendingInputRef.current.length,
        pendingInputLength: currentLength + data.length,
      });
    } else {
      recordSupportLog("terminal.ws.input.dropped", {
        terminalSessionId,
        length: data.length,
        pendingInputLength: currentLength,
      }, "warn");
    }
  }, [terminalSessionId]);

  const sendResize = useCallback((cols: number, rows: number) => {
    pendingResizeRef.current = { cols, rows };
    sendMessage(socketRef.current, { type: "resize", cols, rows });
  }, []);

  const sendSignal = useCallback((signal: TerminalSignal) => {
    sendMessage(socketRef.current, { type: "signal", signal });
  }, []);

  return {
    connectionStatus,
    error,
    metadata,
    notFound,
    runtimeStatus,
    sendInput,
    sendResize,
    sendSignal,
  };
}
