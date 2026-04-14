import { useCallback, useEffect, useRef, useState } from "react";
import type {
  TerminalClientMessage,
  TerminalServerMessage,
} from "@browser-viewer/shared";
import { HttpError } from "../../services/http";
import { createTerminalWsTicket } from "../../services/terminal";
import {
  getTerminalReconnectDelay,
  MIN_TERMINAL_RECONNECT_LIFETIME_MS,
  shouldAutoReconnectTerminalClose,
} from "./reconnect-policy";
import { logTerminalPerf, summarizeTerminalChunk } from "./perf-logging";
import { toWebSocketBase } from "../viewer/url";

type ConnectionStatus = "connecting" | "connected" | "closed";
type TerminalRuntimeStatus = "running" | "exited" | null;
const MAX_PENDING_INPUT_CHARS = 8 * 1024;

function buildTerminalWsUrl(
  apiBase: string,
  terminalSessionId: string,
  ticket: string,
  includeSnapshot: boolean,
): string {
  const searchParams = new URLSearchParams({
    terminalSessionId,
    token: ticket,
  });
  if (!includeSnapshot) {
    searchParams.set("snapshot", "0");
  }
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

export function useTerminalConnection(params: {
  apiBase: string;
  terminalSessionId: string;
  token: string;
  onAuthExpired?: () => void;
  onSnapshot?: (data: string) => void;
  onOutput?: (data: string) => void;
  onMetadata?: (metadata: { name: string; cwd: string }) => void;
  includeSnapshot?: boolean;
}) {
  const {
    apiBase,
    terminalSessionId,
    token,
    onAuthExpired,
    onSnapshot,
    onOutput,
    onMetadata,
    includeSnapshot = true,
  } = params;
  const socketRef = useRef<WebSocket | null>(null);
  const tokenRef = useRef(token);
  const pendingResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const stableConnectionTimerRef = useRef<number | null>(null);
  const reconnectCountRef = useRef(0);
  const connectedAtRef = useRef<number | null>(null);
  const closeReasonRef = useRef<string | null>(null);
  const terminalStatusRef = useRef<TerminalRuntimeStatus>(null);
  const outboundSequenceRef = useRef(0);
  const inboundSequenceRef = useRef(0);
  const pendingInputRef = useRef<string[]>([]);
  const connectionStatusRef = useRef<ConnectionStatus>("connecting");
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

  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [terminalStatus, setTerminalStatus] =
    useState<TerminalRuntimeStatus>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualReconnectNonce, setManualReconnectNonce] = useState(0);

  const setNextConnectionStatus = useCallback(
    (status: ConnectionStatus): void => {
      connectionStatusRef.current = status;
      setConnectionStatus(status);
    },
    [],
  );
  const setNextTerminalStatus = useCallback(
    (status: TerminalRuntimeStatus): void => {
      terminalStatusRef.current = status;
      setTerminalStatus(status);
    },
    [],
  );

  useEffect(() => {
    setNextConnectionStatus("connecting");
    setNextTerminalStatus(null);
    setExitCode(null);
    setError(null);
    let cancelled = false;

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current === null) {
        return;
      }

      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    };

    const clearStableConnectionTimer = () => {
      if (stableConnectionTimerRef.current === null) {
        return;
      }

      window.clearTimeout(stableConnectionTimerRef.current);
      stableConnectionTimerRef.current = null;
    };

    const flushPendingInput = (socket: WebSocket): void => {
      if (
        socket.readyState !== WebSocket.OPEN ||
        pendingInputRef.current.length === 0
      ) {
        return;
      }

      const pendingInput = pendingInputRef.current.splice(0);
      for (const data of pendingInput) {
        sendMessage(socket, {
          type: "input",
          data,
        });
      }
    };

    const connect = async (): Promise<void> => {
      if (cancelled) {
        return;
      }

      clearReconnectTimer();
      setNextConnectionStatus("connecting");
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
          includeSnapshot,
        );

        const socket = new WebSocket(wsUrl);
        socketRef.current = socket;

        socket.addEventListener("open", () => {
          if (socketRef.current !== socket) {
            return;
          }

          connectedAtRef.current = Date.now();
          closeReasonRef.current = null;
          clearStableConnectionTimer();
          stableConnectionTimerRef.current = window.setTimeout(() => {
            if (socketRef.current === socket) {
              reconnectCountRef.current = 0;
            }
            stableConnectionTimerRef.current = null;
          }, MIN_TERMINAL_RECONNECT_LIFETIME_MS);
          setError(null);
          setNextConnectionStatus("connected");
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
          flushPendingInput(socket);
        });
        socket.addEventListener("close", (event) => {
          if (socketRef.current !== socket) {
            return;
          }

          socketRef.current = null;
          clearStableConnectionTimer();

          if (event.code === 1008 && event.reason === "Unauthorized") {
            setNextConnectionStatus("closed");
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
            reconnectAttempt: reconnectCountRef.current,
            terminalStatus: terminalStatusRef.current,
          });

          const closeReason = closeReasonRef.current || event.reason || null;
          const reconnectAttempt = reconnectCountRef.current;
          if (
            !cancelled &&
            shouldAutoReconnectTerminalClose({
              code: event.code,
              livedMs,
              reason: closeReason,
              reconnectAttempt,
              terminalStatus: terminalStatusRef.current,
            })
          ) {
            const delay = getTerminalReconnectDelay(reconnectAttempt);
            reconnectCountRef.current = reconnectAttempt + 1;
            setNextConnectionStatus("connecting");
            clearReconnectTimer();
            reconnectTimerRef.current = window.setTimeout(() => {
              void connect();
            }, delay);
            return;
          }

          setNextConnectionStatus("closed");
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
            const parsed = JSON.parse(
              String(event.data),
            ) as TerminalServerMessage;
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
              setNextTerminalStatus(parsed.status);
              setExitCode(parsed.exitCode ?? null);
              return;
            }
            if (parsed.type === "exit") {
              logTerminalPerf("ws.message.exit", {
                terminalSessionId,
                seq: inboundSequenceRef.current,
                exitCode: parsed.exitCode ?? null,
              });
              setNextTerminalStatus("exited");
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
        setNextConnectionStatus("closed");
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
      clearStableConnectionTimer();
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [
    apiBase,
    includeSnapshot,
    manualReconnectNonce,
    onAuthExpired,
    setNextConnectionStatus,
    setNextTerminalStatus,
    terminalSessionId,
  ]);

  const queuePendingInput = useCallback(
    (data: string, socketReadyState: number | null): void => {
      pendingInputRef.current.push(data);
      let totalLen = pendingInputRef.current.reduce(
        (total, chunk) => total + chunk.length,
        0,
      );
      while (
        pendingInputRef.current.length > 0 &&
        totalLen > MAX_PENDING_INPUT_CHARS
      ) {
        totalLen -= pendingInputRef.current.shift()?.length ?? 0;
      }
      if (socketReadyState === null || socketReadyState === WebSocket.CLOSED) {
        if (connectionStatusRef.current !== "connecting") {
          setNextConnectionStatus("connecting");
          setManualReconnectNonce((current) => current + 1);
        }
      }
    },
    [setNextConnectionStatus],
  );

  return {
    connectionStatus,
    terminalStatus,
    exitCode,
    error,
    sendInput: useCallback(
      (data: string) => {
        outboundSequenceRef.current += 1;
        const socket = socketRef.current;
        logTerminalPerf("ws.send.input", {
          terminalSessionId,
          seq: outboundSequenceRef.current,
          socketReadyState: socket?.readyState ?? null,
          ...summarizeTerminalChunk(data),
        });
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          queuePendingInput(data, socket?.readyState ?? null);
          return;
        }

        sendMessage(socket, {
          type: "input",
          data,
        });
      },
      [queuePendingInput, terminalSessionId],
    ),
    sendResize: useCallback(
      (cols: number, rows: number) => {
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
      },
      [terminalSessionId],
    ),
    sendSignal: useCallback(
      (signal: "SIGINT" | "SIGTERM" | "SIGKILL") => {
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
      },
      [terminalSessionId],
    ),
  };
}
