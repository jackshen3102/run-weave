import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type WheelEvent,
} from "react";
import type {
  ClientInputMessage,
  ServerEventMessage,
  ViewerTab,
} from "@browser-viewer/shared";
import { Button } from "./ui/button";
import {
  extractKeyboardModifiers,
  mapClientPointToCanvas,
} from "../lib/coordinate";

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
  const connectedAtRef = useRef<number | null>(null);
  const wsCloseReasonRef = useRef<string | null>(null);
  const lastMoveAtRef = useRef(0);
  const [connectNonce, setConnectNonce] = useState(0);
  const [status, setStatus] = useState("connecting");
  const [error, setError] = useState<string | null>(null);
  const [sentCount, setSentCount] = useState(0);
  const [ackCount, setAckCount] = useState(0);
  const [tabs, setTabs] = useState<ViewerTab[]>([]);
  const moveLogCounterRef = useRef(0);
  const wsUrl = useMemo(
    () => `${toWebSocketBase(apiBase)}/ws?sessionId=${sessionId}`,
    [apiBase, sessionId],
  );

  const sendInput = (input: ClientInputMessage): void => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.log("[viewer-fe] skip send input: websocket not open", {
        sessionId,
        type: input.type,
        action: input.type === "mouse" ? input.action : undefined,
      });
      return;
    }

    if (input.type !== "mouse" || input.action !== "move") {
      console.log("[viewer-fe] send input", { sessionId, input });
    } else {
      moveLogCounterRef.current += 1;
      if (moveLogCounterRef.current % 30 === 0) {
        console.log("[viewer-fe] send mouse move (sampled)", {
          sessionId,
          count: moveLogCounterRef.current,
          x: input.x,
          y: input.y,
        });
      }
    }

    wsRef.current.send(JSON.stringify(input));
    setSentCount((value) => value + 1);
  };

  const mapPointerEvent = (
    event: Pick<
      MouseEvent<HTMLCanvasElement> | WheelEvent<HTMLCanvasElement>,
      "clientX" | "clientY"
    >,
  ) => {
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
      console.log("[viewer-fe] websocket connecting", { sessionId, wsUrl });

      ws.onopen = () => {
        if (wsRef.current !== ws) {
          return;
        }
        connectedAtRef.current = Date.now();
        wsCloseReasonRef.current = null;
        reconnectCountRef.current = 0;
        setStatus("connected");
        setError(null);
        console.log("[viewer-fe] websocket connected", { sessionId });
      };

      ws.onmessage = async (event) => {
        if (wsRef.current !== ws) {
          return;
        }
        if (typeof event.data === "string") {
          try {
            const message = JSON.parse(event.data) as ServerEventMessage;
            if (message.type === "error") {
              wsCloseReasonRef.current = message.message;
              setError(message.message);
              console.log("[viewer-fe] websocket control error", {
                sessionId,
                message: message.message,
              });
            } else if (message.type === "tabs") {
              setTabs(message.tabs);
              console.log("[viewer-fe] websocket tabs", {
                sessionId,
                count: message.tabs.length,
                activeTab: message.tabs.find((tab) => tab.active)?.id,
              });
            } else if (message.type === "ack") {
              setAckCount((value) => value + 1);
              console.log("[viewer-fe] websocket ack", {
                sessionId,
                eventType: message.eventType,
              });
            } else {
              console.log("[viewer-fe] websocket control message", {
                sessionId,
                message,
              });
            }
          } catch {
            setError("Received malformed control message.");
            console.log("[viewer-fe] malformed control message", {
              sessionId,
              raw: event.data,
            });
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

        const blob = new Blob([event.data as ArrayBuffer], {
          type: "image/jpeg",
        });
        const bitmap = await createImageBitmap(blob);

        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }

        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
      };

      ws.onerror = () => {
        if (wsRef.current !== ws) {
          return;
        }
        if (!closed) {
          setError("WebSocket connection failed.");
          console.log("[viewer-fe] websocket error", { sessionId });
        }
      };

      ws.onclose = (event) => {
        const isCurrentSocket = wsRef.current === ws;
        if (isCurrentSocket) {
          wsRef.current = null;
        }
        if (closed) {
          console.log("[viewer-fe] websocket closed after cleanup", {
            sessionId,
          });
          return;
        }

        if (!isCurrentSocket) {
          return;
        }

        const connectedAt = connectedAtRef.current;
        const livedMs = connectedAt ? Date.now() - connectedAt : 0;
        connectedAtRef.current = null;
        const closedByPolicy = event.code === 1008;

        if (closedByPolicy || livedMs < 1000) {
          setStatus("closed");
          const closeReason =
            wsCloseReasonRef.current ||
            event.reason ||
            "WebSocket closed repeatedly. Please click Reconnect.";
          setError(closeReason);
          console.log("[viewer-fe] websocket closed, stop auto reconnect", {
            sessionId,
            code: event.code,
            reason: event.reason,
            eventMessage: wsCloseReasonRef.current,
            livedMs,
          });
          return;
        }

        setStatus("reconnecting");
        const attempt = reconnectCountRef.current;
        const delay = Math.min(250 * 2 ** attempt, 5000);
        reconnectCountRef.current += 1;
        console.log("[viewer-fe] websocket closed, scheduling reconnect", {
          sessionId,
          attempt,
          delay,
          code: event.code,
          livedMs,
        });

        reconnectTimerRef.current = window.setTimeout(() => {
          connect();
        }, delay);
      };
    };

    connect();

    return () => {
      closed = true;
      connectedAtRef.current = null;
      wsCloseReasonRef.current = null;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      console.log("[viewer-fe] cleanup viewer page and close websocket", {
        sessionId,
      });
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [wsUrl, connectNonce, sessionId]);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-4 p-4 sm:p-8">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">Live Viewer</h1>
          <p className="text-sm text-muted-foreground">Session: {sessionId}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            Status: {status}
          </span>
          {(status === "reconnecting" || status === "closed") && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                reconnectCountRef.current = 0;
                connectedAtRef.current = null;
                wsCloseReasonRef.current = null;
                setStatus("connecting");
                setError(null);
                setConnectNonce((value) => value + 1);
              }}
            >
              Reconnect
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => window.location.assign("/")}
          >
            Back
          </Button>
        </div>
      </header>

      <section className="rounded-xl border border-border/80 bg-card/70 p-3 backdrop-blur">
        <div className="mb-3 flex flex-wrap gap-2" data-testid="tab-list">
          {tabs.map((tab) => (
            <Button
              key={tab.id}
              size="sm"
              variant={tab.active ? "default" : "secondary"}
              className="max-w-[220px] truncate"
              aria-pressed={tab.active}
              data-tab-id={tab.id}
              onClick={() => {
                if (tab.active) {
                  return;
                }
                sendInput({ type: "tab", action: "switch", tabId: tab.id });
              }}
              title={tab.title || tab.url}
            >
              {tab.title || tab.url}
            </Button>
          ))}
          {tabs.length === 0 && (
            <p className="text-xs text-muted-foreground">Waiting for tabs...</p>
          )}
        </div>
        {error && <p className="mb-3 text-sm text-red-500">{error}</p>}
        {status === "reconnecting" && !error && (
          <p className="mb-3 text-sm text-amber-600">
            Connection lost, trying to reconnect...
          </p>
        )}
        <p
          className="mb-2 text-xs text-muted-foreground"
          data-testid="ws-stats"
        >
          Sent: {sentCount} | Ack: {ackCount}
        </p>
        <div className="overflow-hidden rounded-md border border-border bg-black/70">
          <canvas
            ref={canvasRef}
            className="h-auto w-full"
            style={{ touchAction: "none" }}
            tabIndex={0}
            onMouseDown={(event) => {
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
                button:
                  event.button === 1
                    ? "middle"
                    : event.button === 2
                      ? "right"
                      : "left",
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
