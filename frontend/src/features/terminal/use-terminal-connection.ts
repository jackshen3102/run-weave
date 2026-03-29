import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TerminalClientMessage, TerminalServerMessage } from "@browser-viewer/shared";
import { toWebSocketBase } from "../viewer/url";

type ConnectionStatus = "connecting" | "connected" | "closed";
type TerminalRuntimeStatus = "running" | "exited" | null;

function buildTerminalWsUrl(
  apiBase: string,
  terminalSessionId: string,
  token: string,
): string {
  return `${toWebSocketBase(apiBase)}/ws/terminal?terminalSessionId=${encodeURIComponent(
    terminalSessionId,
  )}&token=${encodeURIComponent(token)}`;
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

  const wsUrl = useMemo(
    () => buildTerminalWsUrl(apiBase, terminalSessionId, token),
    [apiBase, terminalSessionId, token],
  );

  useEffect(() => {
    setConnectionStatus("connecting");
    setTerminalStatus(null);
    setExitCode(null);
    setError(null);
    setOutput("");
    let cancelled = false;
    let socket: WebSocket | null = null;

    const connectTimer = window.setTimeout(() => {
      if (cancelled) {
        return;
      }

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
  }, [onAuthExpired, wsUrl]);

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
