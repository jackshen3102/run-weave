import { useCallback, useEffect, useRef, useState } from "react";
import type {
  TerminalClientMessage,
  TerminalServerMessage,
  TerminalSignal,
  TerminalSessionStatusResponse,
} from "@browser-viewer/shared";
import type { TerminalRendererHandle } from "@browser-viewer/terminal-renderer";

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
  lastActivityAt: string;
  status: "running" | "exited";
}

const MAX_PENDING_INPUT_CHARS = 8 * 1024;

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

    const flushPendingInput = (socket: WebSocket) => {
      const pendingInput = pendingInputRef.current.splice(0);
      for (const data of pendingInput) {
        sendMessage(socket, { type: "input", data });
      }
    };

    const scheduleReconnect = () => {
      clearReconnectTimer();
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
      try {
        const ticketPayload = await createTerminalWsTicket(
          apiBase,
          tokenRef.current,
          terminalSessionId,
        );
        if (cancelled) {
          return;
        }

        const socket = new WebSocket(
          buildTerminalWsUrl(apiBase, terminalSessionId, ticketPayload.ticket),
        );
        socketRef.current = socket;

        socket.addEventListener("open", () => {
          if (socketRef.current !== socket) {
            return;
          }
          setConnectionStatus("connected");
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
                  }
                : {
                    cwd: message.cwd,
                    command: "",
                    activeCommand: message.activeCommand,
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
            setError("终端连接失败");
          }
        });
      } catch (nextError) {
        if (nextError instanceof ApiError && nextError.status === 401) {
          onAuthExpired();
          return;
        }
        if (nextError instanceof ApiError && nextError.status === 404) {
          setNotFound(true);
          setError("终端不存在或已被删除");
          return;
        }
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
      return;
    }

    const currentLength = pendingInputRef.current.reduce(
      (total, chunk) => total + chunk.length,
      0,
    );
    if (currentLength + data.length <= MAX_PENDING_INPUT_CHARS) {
      pendingInputRef.current.push(data);
    }
  }, []);

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
