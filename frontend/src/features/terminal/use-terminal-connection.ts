import { useCallback, useEffect, useRef, useState } from "react";
import type { TerminalClientMessage, TerminalServerMessage } from "@browser-viewer/shared";
import { HttpError } from "../../services/http";
import { createTerminalWsTicket } from "../../services/terminal";
import {
  getTerminalReconnectDelay,
  shouldAutoReconnectTerminalClose,
} from "./reconnect-policy";
import { toWebSocketBase } from "../viewer/url";

type ConnectionStatus = "connecting" | "connected" | "closed";
type TerminalRuntimeStatus = "running" | "exited" | null;
const MAX_UNAUTHORIZED_RETRIES = 1;
const TERMINAL_PERF_LOG_PREFIX = "[terminal-perf-fe]";

function summarizeTerminalChunk(data: string): { len: number; preview: string } {
  return {
    len: data.length,
    preview: JSON.stringify(data.slice(0, 32)),
  };
}

function logTerminalPerf(
  event: string,
  details: Record<string, unknown>,
): void {
  console.info(TERMINAL_PERF_LOG_PREFIX, event, {
    at: new Date().toISOString(),
    ...details,
  });
}

function buildTerminalWsUrl(
  apiBase: string,
  terminalSessionId: string,
  ticket: string,
): string {
  return `${toWebSocketBase(apiBase)}/ws/terminal?terminalSessionId=${encodeURIComponent(
    terminalSessionId,
  )}&token=${encodeURIComponent(ticket)}`;
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

export function useTerminalConnection(params: {
  apiBase: string;
  terminalSessionId: string;
  token: string;
  onAuthExpired?: () => void;
  onSnapshot?: (data: string) => void;
  onOutput?: (data: string) => void;
  onMetadata?: (metadata: { name: string; cwd: string }) => void;
}) {
  const {
    apiBase,
    terminalSessionId,
    token,
    onAuthExpired,
    onSnapshot,
    onOutput,
    onMetadata,
  } =
    params;
  const socketRef = useRef<WebSocket | null>(null);
  const tokenRef = useRef(token);
  const pendingResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectCountRef = useRef(0);
  const connectedAtRef = useRef<number | null>(null);
  const closeReasonRef = useRef<string | null>(null);
  const outboundSequenceRef = useRef(0);
  const inboundSequenceRef = useRef(0);
  // Keep onOutput in a ref so it never needs to be in the effect's dep array.
  const onSnapshotRef = useRef(onSnapshot);
  const onOutputRef = useRef(onOutput);
  const onMetadataRef = useRef(onMetadata);
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);
  useEffect(() => {
    onSnapshotRef.current = onSnapshot;
  }, [onSnapshot]);
  useEffect(() => {
    onOutputRef.current = onOutput;
  }, [onOutput]);
  useEffect(() => {
    onMetadataRef.current = onMetadata;
  }, [onMetadata]);

  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [terminalStatus, setTerminalStatus] = useState<TerminalRuntimeStatus>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setConnectionStatus("connecting");
    setTerminalStatus(null);
    setExitCode(null);
    setError(null);
    let cancelled = false;
    let unauthorizedRetryCount = 0;

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current === null) {
        return;
      }

      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    };

    const connect = async (): Promise<void> => {
      if (cancelled) {
        return;
      }

      clearReconnectTimer();
      setConnectionStatus("connecting");
      setError(null);
      logTerminalPerf("ws.connect.start", {
        terminalSessionId,
        reconnectCount: reconnectCountRef.current,
      });

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

          connectedAtRef.current = Date.now();
          closeReasonRef.current = null;
          reconnectCountRef.current = 0;
          setError(null);
          setConnectionStatus("connected");
          logTerminalPerf("ws.open", {
            terminalSessionId,
            pendingResize: pendingResizeRef.current,
          });
          if (pendingResizeRef.current) {
            sendMessage(socket, {
              type: "resize",
              cols: pendingResizeRef.current.cols,
              rows: pendingResizeRef.current.rows,
            });
          }
        });
        socket.addEventListener("close", (event) => {
          if (socketRef.current !== socket) {
            return;
          }

          socketRef.current = null;

          if (event.code === 1008 && event.reason === "Unauthorized") {
            if (
              unauthorizedRetryCount < MAX_UNAUTHORIZED_RETRIES &&
              !cancelled
            ) {
              unauthorizedRetryCount += 1;
              closeReasonRef.current = null;
              setConnectionStatus("connecting");
              void connect();
              return;
            }
            setConnectionStatus("closed");
            onAuthExpired?.();
            return;
          }

          const connectedAt = connectedAtRef.current;
          const livedMs = connectedAt ? Date.now() - connectedAt : 0;
          connectedAtRef.current = null;
          logTerminalPerf("ws.close", {
            terminalSessionId,
            code: event.code,
            reason: event.reason,
            livedMs,
            closeReason: closeReasonRef.current,
          });

          if (
            !cancelled &&
            shouldAutoReconnectTerminalClose({
              code: event.code,
              livedMs,
            })
          ) {
            const delay = getTerminalReconnectDelay(reconnectCountRef.current);
            reconnectCountRef.current += 1;
            setConnectionStatus("connecting");
            clearReconnectTimer();
            reconnectTimerRef.current = window.setTimeout(() => {
              void connect();
            }, delay);
            return;
          }

          setConnectionStatus("closed");
          if (closeReasonRef.current || event.reason) {
            setError(
              closeReasonRef.current ||
                event.reason ||
                "Terminal connection closed.",
            );
          }
        });
        socket.addEventListener("message", (event) => {
          if (socketRef.current !== socket) {
            return;
          }

          try {
            const parsed = JSON.parse(String(event.data)) as TerminalServerMessage;
            inboundSequenceRef.current += 1;
            if (parsed.type === "snapshot") {
              logTerminalPerf("ws.message.snapshot", {
                terminalSessionId,
                seq: inboundSequenceRef.current,
                ...summarizeTerminalChunk(parsed.data),
              });
              onSnapshotRef.current?.(parsed.data);
              return;
            }
            if (parsed.type === "output") {
              logTerminalPerf("ws.message.output", {
                terminalSessionId,
                seq: inboundSequenceRef.current,
                ...summarizeTerminalChunk(parsed.data),
              });
              onOutputRef.current?.(parsed.data);
              return;
            }
            if (parsed.type === "metadata") {
              logTerminalPerf("ws.message.metadata", {
                terminalSessionId,
                seq: inboundSequenceRef.current,
                name: parsed.name,
                cwd: parsed.cwd,
              });
              onMetadataRef.current?.({
                name: parsed.name,
                cwd: parsed.cwd,
              });
              return;
            }
            if (parsed.type === "status") {
              logTerminalPerf("ws.message.status", {
                terminalSessionId,
                seq: inboundSequenceRef.current,
                status: parsed.status,
                exitCode: parsed.exitCode ?? null,
              });
              setTerminalStatus(parsed.status);
              setExitCode(parsed.exitCode ?? null);
              return;
            }
            if (parsed.type === "exit") {
              logTerminalPerf("ws.message.exit", {
                terminalSessionId,
                seq: inboundSequenceRef.current,
                exitCode: parsed.exitCode ?? null,
              });
              setTerminalStatus("exited");
              setExitCode(parsed.exitCode ?? null);
              return;
            }
            if (parsed.type === "error") {
              logTerminalPerf("ws.message.error", {
                terminalSessionId,
                seq: inboundSequenceRef.current,
                message: parsed.message,
              });
              closeReasonRef.current = parsed.message;
              setError(parsed.message);
              if (parsed.message === "Unauthorized") {
                onAuthExpired?.();
              }
            }
          } catch {
            closeReasonRef.current = "Invalid terminal message";
            setError("Invalid terminal message");
          }
        });
      } catch (error) {
        if (cancelled) {
          return;
        }

        if (error instanceof HttpError && error.status === 401) {
          onAuthExpired?.();
          return;
        }

        logTerminalPerf("ws.connect.error", {
          terminalSessionId,
          error: String(error),
        });
        closeReasonRef.current = String(error);
        setError(String(error));
        setConnectionStatus("closed");
      }
    };

    const connectTimer = window.setTimeout(() => {
      void connect();
    }, 0);

    return () => {
      cancelled = true;
      connectedAtRef.current = null;
      closeReasonRef.current = null;
      reconnectCountRef.current = 0;
      window.clearTimeout(connectTimer);
      clearReconnectTimer();
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [apiBase, onAuthExpired, terminalSessionId]);

  return {
    connectionStatus,
    terminalStatus,
    exitCode,
    error,
    sendInput: useCallback((data: string) => {
      outboundSequenceRef.current += 1;
      logTerminalPerf("ws.send.input", {
        terminalSessionId,
        seq: outboundSequenceRef.current,
        socketReadyState: socketRef.current?.readyState ?? null,
        ...summarizeTerminalChunk(data),
      });
      sendMessage(socketRef.current, {
        type: "input",
        data,
      });
    }, [terminalSessionId]),
    sendResize: useCallback((cols: number, rows: number) => {
      pendingResizeRef.current = { cols, rows };
      outboundSequenceRef.current += 1;
      logTerminalPerf("ws.send.resize", {
        terminalSessionId,
        seq: outboundSequenceRef.current,
        socketReadyState: socketRef.current?.readyState ?? null,
        cols,
        rows,
      });
      sendMessage(socketRef.current, {
        type: "resize",
        cols,
        rows,
      });
    }, [terminalSessionId]),
    sendSignal: useCallback((signal: "SIGINT" | "SIGTERM" | "SIGKILL") => {
      outboundSequenceRef.current += 1;
      logTerminalPerf("ws.send.signal", {
        terminalSessionId,
        seq: outboundSequenceRef.current,
        socketReadyState: socketRef.current?.readyState ?? null,
        signal,
      });
      sendMessage(socketRef.current, {
        type: "signal",
        signal,
      });
    }, [terminalSessionId]),
  };
}
