import { useCallback, useEffect, useRef, useState } from "react";
import type { TerminalClientMessage, TerminalServerMessage } from "@browser-viewer/shared";
import { HttpError } from "../../services/http";
import { createTerminalWsTicket } from "../../services/terminal";
import { toWebSocketBase } from "../viewer/url";

type ConnectionStatus = "connecting" | "connected" | "closed";
type TerminalRuntimeStatus = "running" | "exited" | null;

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
}) {
  const { apiBase, terminalSessionId, token, onAuthExpired } = params;
  const socketRef = useRef<WebSocket | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [terminalStatus, setTerminalStatus] = useState<TerminalRuntimeStatus>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState("");

  useEffect(() => {
    setConnectionStatus("connecting");
    setTerminalStatus(null);
    setExitCode(null);
    setError(null);
    setOutput("");
    let cancelled = false;
    let socket: WebSocket | null = null;
    let retriedWithFreshTicket = false;

    const connectTimer = window.setTimeout(() => {
      const connect = async (): Promise<void> => {
        if (cancelled) {
          return;
        }

        try {
          const ticketPayload = await createTerminalWsTicket(
            apiBase,
            token,
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

          socket = new WebSocket(wsUrl);
          socketRef.current = socket;

          socket.addEventListener("open", () => {
            if (socketRef.current !== socket) {
              return;
            }
            setConnectionStatus("connected");
          });
          socket.addEventListener("close", (event) => {
            if (socketRef.current !== socket) {
              return;
            }
            setConnectionStatus("closed");
            if (event.code === 1008 && event.reason === "Unauthorized") {
              if (!retriedWithFreshTicket && !cancelled) {
                retriedWithFreshTicket = true;
                void connect();
                return;
              }
              onAuthExpired?.();
            }
          });
          socket.addEventListener("message", (event) => {
            if (socketRef.current !== socket) {
              return;
            }

            try {
              const parsed = JSON.parse(String(event.data)) as TerminalServerMessage;
              if (parsed.type === "output") {
                setOutput((current) => `${current}${parsed.data}`);
                return;
              }
              if (parsed.type === "status") {
                setTerminalStatus(parsed.status);
                setExitCode(parsed.exitCode ?? null);
                return;
              }
              if (parsed.type === "exit") {
                setTerminalStatus("exited");
                setExitCode(parsed.exitCode ?? null);
                return;
              }
              if (parsed.type === "error") {
                setError(parsed.message);
                if (parsed.message === "Unauthorized") {
                  onAuthExpired?.();
                }
              }
            } catch {
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
          setError(String(error));
          setConnectionStatus("closed");
        }
      };

      void connect();
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(connectTimer);
      if (socket) {
        socket.close();
      }
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
    };
  }, [apiBase, onAuthExpired, terminalSessionId, token]);

  return {
    connectionStatus,
    terminalStatus,
    exitCode,
    error,
    output,
    clearOutput: useCallback(() => {
      setOutput("");
    }, []),
    sendInput: useCallback((data: string) => {
      sendMessage(socketRef.current, {
        type: "input",
        data,
      });
    }, []),
    sendResize: useCallback((cols: number, rows: number) => {
      sendMessage(socketRef.current, {
        type: "resize",
        cols,
        rows,
      });
    }, []),
    sendSignal: useCallback((signal: "SIGINT" | "SIGTERM" | "SIGKILL") => {
      sendMessage(socketRef.current, {
        type: "signal",
        signal,
      });
    }, []),
  };
}
