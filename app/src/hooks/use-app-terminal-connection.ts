import { useMemoizedFn } from "ahooks";
import { useEffect, useRef, useState } from "react";
import type { TerminalSessionStatusResponse } from "@runweave/shared/terminal/session";
import type { TerminalClientMessage, TerminalServerMessage, TerminalSignal } from "@runweave/shared/terminal/websocket";
import type { TerminalRendererHandle } from "@runweave/terminal-renderer";

import { classifyApiFailure } from "../services/api-failure";
import {
  createTerminalWsTicket,
  getTerminalSession,
} from "../services/terminal";

type ConnectionStatus = "connecting" | "connected" | "closed";
type RuntimeStatus = "running" | "exited" | null;
type RuntimeKind = "tmux" | "pty" | null;

interface TerminalMetadata {
  cwd: string;
  command: string;
  activeCommand: string | null;
  projectId: string | null;
  lastActivityAt: string;
  status: "running" | "exited";
}

const MAX_PENDING_INPUT_CHARS = 8 * 1024;
const MAX_PENDING_OUTPUT_CHARS = 64 * 1024;

export interface SendInputResult {
  accepted: boolean;
  reason?: "disabled" | "queue-full";
}

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

function closeWebSocket(
  socket: WebSocket | null,
  code: number,
  reason: string,
) {
  if (!socket) {
    return;
  }
  if (socket.readyState === WebSocket.CONNECTING) {
    socket.addEventListener("open", () => socket.close(code, reason), {
      once: true,
    });
    return;
  }
  if (
    socket.readyState === WebSocket.OPEN ||
    socket.readyState === WebSocket.CLOSING
  ) {
    socket.close(code, reason);
  }
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
  enabled = true,
  canQueueInput = true,
  onAuthExpired,
  onConnectionFailure,
}: {
  apiBase: string;
  accessToken: string;
  terminalSessionId: string;
  rendererRef: React.RefObject<TerminalRendererHandle | null>;
  enabled?: boolean;
  canQueueInput?: boolean;
  onAuthExpired: () => void;
  onConnectionFailure?: () => void;
}) {
  const socketRef = useRef<WebSocket | null>(null);
  const pendingInputRef = useRef<string[]>([]);
  const pendingResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const pendingScrollbackRef = useRef<string | null>(null);
  const pendingOutputRef = useRef("");
  const reconnectTimerRef = useRef<number | null>(null);
  const tokenRef = useRef(accessToken);
  const runtimeStatusRef = useRef<RuntimeStatus>(null);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus>(null);
  const [runtimeKind, setRuntimeKind] = useState<RuntimeKind>(null);
  const [metadata, setMetadata] = useState<TerminalMetadata | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    tokenRef.current = accessToken;
  }, [accessToken]);

  const setNextRuntimeStatus = useMemoizedFn((status: RuntimeStatus) => {
    runtimeStatusRef.current = status;
    setRuntimeStatus(status);
  });

  const flushPendingRendererWrites = useMemoizedFn(() => {
    const renderer = rendererRef.current;
    if (!renderer) {
      return false;
    }
    const pendingScrollback = pendingScrollbackRef.current;
    const pendingOutput = pendingOutputRef.current;
    if (pendingScrollback !== null) {
      pendingScrollbackRef.current = null;
      renderer.resetAndWrite(pendingScrollback);
    }
    if (pendingOutput) {
      pendingOutputRef.current = "";
      renderer.write(pendingOutput);
    }
    return pendingScrollback !== null || Boolean(pendingOutput);
  });

  const writeScrollback = useMemoizedFn((data: string) => {
    const renderer = rendererRef.current;
    if (!renderer) {
      pendingScrollbackRef.current = data;
      pendingOutputRef.current = "";
      return;
    }
    pendingScrollbackRef.current = null;
    renderer.resetAndWrite(data);
  });

  const writeOutput = useMemoizedFn((data: string) => {
    const renderer = rendererRef.current;
    if (!renderer) {
      pendingOutputRef.current = `${pendingOutputRef.current}${data}`.slice(
        -MAX_PENDING_OUTPUT_CHARS,
      );
      return;
    }
    flushPendingRendererWrites();
    renderer.write(data);
  });

  const handleRendererReady = useMemoizedFn(() => {
    flushPendingRendererWrites();
  });

  useEffect(() => {
    let cancelled = false;
    if (!enabled) {
      return () => {
        cancelled = true;
      };
    }

    void getTerminalSession(apiBase, accessToken, terminalSessionId)
      .then((session) => {
        if (cancelled) {
          return;
        }
        setMetadata(toTerminalMetadata(session));
        setNextRuntimeStatus(session.status);
        if (session.scrollback) {
          writeScrollback(session.scrollback);
        }
      })
      .catch((nextError: unknown) => {
        if (cancelled) {
          return;
        }
        const failure = classifyApiFailure(nextError);
        if (failure.kind === "auth-expired") {
          onAuthExpired();
          return;
        }
        if (failure.kind === "not-found") {
          setNotFound(true);
          setError("终端不存在或已被删除");
          return;
        }
        onConnectionFailure?.();
        setError(nextError instanceof Error ? nextError.message : "加载失败");
      });

    return () => {
      cancelled = true;
    };
  }, [
    accessToken,
    apiBase,
    enabled,
    onConnectionFailure,
    onAuthExpired,
    setNextRuntimeStatus,
    terminalSessionId,
    writeScrollback,
  ]);

  useEffect(() => {
    let cancelled = false;

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    if (!enabled) {
      setConnectionStatus("closed");
      pendingInputRef.current = [];
      clearReconnectTimer();
      closeWebSocket(socketRef.current, 1000, "AppTerminalPage disabled");
      socketRef.current = null;
      return () => {
        cancelled = true;
        clearReconnectTimer();
      };
    }

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

        const wsUrl = buildTerminalWsUrl(
          apiBase,
          terminalSessionId,
          ticketPayload.ticket,
        );

        const socket = new WebSocket(wsUrl);
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
          if (message.type === "connected") {
            setRuntimeKind(message.runtimeKind ?? null);
            return;
          }
          if (message.type === "snapshot") {
            writeScrollback(message.data);
            return;
          }
          if (message.type === "output") {
            writeOutput(message.data);
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
          if (event.code === 1008 && event.reason === "Unauthorized") {
            setConnectionStatus("closed");
            onAuthExpired();
            return;
          }
          setConnectionStatus("closed");
          onConnectionFailure?.();
          if (!cancelled && runtimeStatusRef.current !== "exited") {
            scheduleReconnect();
          }
        });

        socket.addEventListener("error", () => {
          if (socketRef.current === socket) {
            setError("终端连接失败");
            onConnectionFailure?.();
          }
        });
      } catch (nextError) {
        const failure = classifyApiFailure(nextError);
        if (failure.kind === "auth-expired") {
          onAuthExpired();
          return;
        }
        if (failure.kind === "not-found") {
          setNotFound(true);
          setError("终端不存在或已被删除");
          return;
        }
        setConnectionStatus("closed");
        setError(nextError instanceof Error ? nextError.message : "连接失败");
        onConnectionFailure?.();
        if (!cancelled) {
          scheduleReconnect();
        }
      }
    };

    void connect();
    return () => {
      cancelled = true;
      clearReconnectTimer();
      closeWebSocket(socketRef.current, 1000, "AppTerminalPage unmounted");
      socketRef.current = null;
    };
  }, [
    apiBase,
    enabled,
    onConnectionFailure,
    onAuthExpired,
    setNextRuntimeStatus,
    terminalSessionId,
    writeOutput,
    writeScrollback,
  ]);

  const sendInput = useMemoizedFn((data: string): SendInputResult => {
    if (!data) {
      return { accepted: false, reason: "disabled" };
    }
    if (!enabled || !canQueueInput) {
      pendingInputRef.current = [];
      return { accepted: false, reason: "disabled" };
    }
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      sendMessage(socket, { type: "input", data });
      return { accepted: true };
    }

    const currentLength = pendingInputRef.current.reduce(
      (total, chunk) => total + chunk.length,
      0,
    );
    if (currentLength + data.length <= MAX_PENDING_INPUT_CHARS) {
      pendingInputRef.current.push(data);
      return { accepted: true };
    } else {
      return { accepted: false, reason: "queue-full" };
    }
  });

  const sendResize = useMemoizedFn((cols: number, rows: number) => {
    pendingResizeRef.current = { cols, rows };
    sendMessage(socketRef.current, { type: "resize", cols, rows });
  });

  const sendSignal = useMemoizedFn((signal: TerminalSignal) => {
    sendMessage(socketRef.current, { type: "signal", signal });
  });

  return {
    connectionStatus,
    error,
    metadata,
    notFound,
    runtimeStatus,
    runtimeKind,
    onRendererReady: handleRendererReady,
    sendInput,
    sendResize,
    sendSignal,
  };
}
