import { useEffect, useMemo, useRef, useState, type MouseEvent, type WheelEvent } from "react";
import type { ClientInputMessage, ServerEventMessage } from "@browser-viewer/shared";
import { Button } from "./ui/button";
import { extractKeyboardModifiers, mapClientPointToCanvas } from "../lib/coordinate";

interface ViewerPageProps {
  apiBase: string;
  sessionId: string;
}

function toWebSocketBase(apiBase: string): string {
  if (apiBase.startsWith("https://")) {
    return apiBase.replace("https://", "wss://");
  }
  if (apiBase.startsWith("http://")) {
    return apiBase.replace("http://", "ws://");
  }
  return apiBase;
}

export function ViewerPage({ apiBase, sessionId }: ViewerPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectCountRef = useRef(0);
  const lastMoveAtRef = useRef(0);
  const [connectNonce, setConnectNonce] = useState(0);
  const [status, setStatus] = useState("connecting");
  const [error, setError] = useState<string | null>(null);
  const wsUrl = useMemo(() => `${toWebSocketBase(apiBase)}/ws?sessionId=${sessionId}`, [apiBase, sessionId]);

  const sendInput = (input: ClientInputMessage): void => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }
    wsRef.current.send(JSON.stringify(input));
  };

  const mapPointerEvent = (event: Pick<MouseEvent<HTMLCanvasElement> | WheelEvent<HTMLCanvasElement>, "clientX" | "clientY">) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return null;
    }
    return mapClientPointToCanvas(
      event.clientX,
      event.clientY,
      canvas.getBoundingClientRect(),
      canvas.width,
      canvas.height,
    );
  };

  useEffect(() => {
    let closed = false;
    const connect = (): void => {
      if (closed) {
        return;
      }

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        reconnectCountRef.current = 0;
        setStatus("connected");
        setError(null);
      };

      ws.onmessage = async (event) => {
        if (typeof event.data === "string") {
          try {
            const message = JSON.parse(event.data) as ServerEventMessage;
            if (message.type === "error") {
              setError(message.message);
            }
          } catch {
            setError("Received malformed control message.");
          }
          return;
        }

        const canvas = canvasRef.current;
        if (!canvas) {
          return;
        }

        const ctx = canvas.getContext("2d");
        if (!ctx) {
          return;
        }

        const blob = new Blob([event.data as ArrayBuffer], { type: "image/jpeg" });
        const bitmap = await createImageBitmap(blob);

        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }

        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
      };

      ws.onerror = () => {
        if (!closed) {
          setError("WebSocket connection failed.");
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (closed) {
          return;
        }

        setStatus("reconnecting");
        const attempt = reconnectCountRef.current;
        const delay = Math.min(250 * 2 ** attempt, 2000);
        reconnectCountRef.current += 1;

        reconnectTimerRef.current = window.setTimeout(() => {
          connect();
        }, delay);
      };
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [wsUrl, connectNonce]);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-4 p-4 sm:p-8">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">Live Viewer</h1>
          <p className="text-sm text-muted-foreground">Session: {sessionId}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Status: {status}</span>
          {(status === "reconnecting" || status === "closed") && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                reconnectCountRef.current = 0;
                setStatus("connecting");
                setError(null);
                setConnectNonce((value) => value + 1);
              }}
            >
              Reconnect
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => window.location.assign("/")}>
            Back
          </Button>
        </div>
      </header>

      <section className="rounded-xl border border-border/80 bg-card/70 p-3 backdrop-blur">
        {error && <p className="mb-3 text-sm text-red-500">{error}</p>}
        {status === "reconnecting" && !error && (
          <p className="mb-3 text-sm text-amber-600">Connection lost, trying to reconnect...</p>
        )}
        <div className="overflow-hidden rounded-md border border-border bg-black/70">
          <canvas
            ref={canvasRef}
            className="h-auto w-full"
            style={{ touchAction: "none" }}
            tabIndex={0}
            onClick={(event) => {
              event.currentTarget.focus();
              const point = mapPointerEvent(event);
              if (!point) {
                return;
              }
              sendInput({
                type: "mouse",
                action: "click",
                x: point.x,
                y: point.y,
                button: event.button === 1 ? "middle" : event.button === 2 ? "right" : "left",
              });
            }}
            onMouseMove={(event) => {
              const now = Date.now();
              if (now - lastMoveAtRef.current < 16) {
                return;
              }
              lastMoveAtRef.current = now;

              const point = mapPointerEvent(event);
              if (!point) {
                return;
              }
              sendInput({
                type: "mouse",
                action: "move",
                x: point.x,
                y: point.y,
              });
            }}
            onWheel={(event) => {
              event.preventDefault();
              const point = mapPointerEvent(event);
              sendInput({
                type: "scroll",
                x: point?.x,
                y: point?.y,
                deltaX: event.deltaX,
                deltaY: event.deltaY,
              });
            }}
            onContextMenu={(event) => event.preventDefault()}
            onKeyDown={(event) => {
              event.preventDefault();
              sendInput({
                type: "keyboard",
                key: event.key,
                modifiers: extractKeyboardModifiers(event),
              });
            }}
          />
        </div>
      </section>
    </main>
  );
}
