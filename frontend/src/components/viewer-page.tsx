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
  NavigationState,
  ServerEventMessage,
  ViewerTab,
} from "@browser-viewer/shared";
import { ArrowLeft, ArrowRight, RefreshCw } from "lucide-react";
import { Button } from "./ui/button";
import {
  extractKeyboardModifiers,
  mapClientPointToCanvas,
} from "../lib/coordinate";
import { normalizeRemoteCursor } from "../lib/cursor";

interface ViewerPageProps {
  apiBase: string;
  sessionId: string;
}

function toWebSocketBase(apiBase: string): string {
  if (!apiBase) {
    return window.location.origin.replace(/^http/, "ws");
  }

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
  const [navigationByTabId, setNavigationByTabId] = useState<
    Record<string, NavigationState>
  >({});
  const [addressInput, setAddressInput] = useState("");
  const [isEditingAddress, setIsEditingAddress] = useState(false);
  const moveLogCounterRef = useRef(0);
  const knownTabIdsRef = useRef<Set<string>>(new Set());
  const initialTabIdRef = useRef<string | null>(
    new URLSearchParams(window.location.search).get("tabId"),
  );
  const initialTabSyncedRef = useRef(false);
  const wsUrl = useMemo(
    () => `${toWebSocketBase(apiBase)}/ws?sessionId=${sessionId}`,
    [apiBase, sessionId],
  );

  const syncUrlTabId = (tabId: string | null): void => {
    const params = new URLSearchParams(window.location.search);
    const currentTabId = params.get("tabId");
    if (tabId) {
      if (currentTabId === tabId) {
        return;
      }
      params.set("tabId", tabId);
    } else {
      if (!currentTabId) {
        return;
      }
      params.delete("tabId");
    }

    const query = params.toString();
    const next = query
      ? `${window.location.pathname}?${query}`
      : window.location.pathname;
    window.history.replaceState(null, "", next);
  };

  const activeTabId = tabs.find((tab) => tab.active)?.id ?? null;
  const activeNavigation = activeTabId
    ? navigationByTabId[activeTabId]
    : undefined;

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

  const normalizeNavigationUrl = (rawUrl: string): string | null => {
    const trimmed = rawUrl.trim();
    if (!trimmed) {
      return null;
    }
    if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed)) {
      return trimmed;
    }
    return `https://${trimmed}`;
  };

  const submitNavigation = (): void => {
    if (!activeTabId) {
      return;
    }
    const normalizedUrl = normalizeNavigationUrl(addressInput);
    if (!normalizedUrl) {
      return;
    }

    setAddressInput(normalizedUrl);
    setIsEditingAddress(false);
    sendInput({
      type: "navigation",
      action: "goto",
      tabId: activeTabId,
      url: normalizedUrl,
    });
  };

  useEffect(() => {
    if (isEditingAddress) {
      return;
    }
    setAddressInput(activeNavigation?.url ?? "");
  }, [activeNavigation?.url, isEditingAddress]);

  useEffect(() => {
    let closed = false;
    initialTabSyncedRef.current = false;
    const canvasElement = canvasRef.current;
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
              knownTabIdsRef.current = new Set(
                message.tabs.map((tab) => tab.id),
              );
              setNavigationByTabId((current) => {
                const next: Record<string, NavigationState> = {};
                for (const [tabId, state] of Object.entries(current)) {
                  if (knownTabIdsRef.current.has(tabId)) {
                    next[tabId] = state;
                  }
                }
                return next;
              });

              const activeTab =
                message.tabs.find((tab) => tab.active)?.id ?? null;
              const initialTabId = initialTabIdRef.current;

              if (!initialTabSyncedRef.current && message.tabs.length > 0) {
                initialTabSyncedRef.current = true;
                if (
                  initialTabId &&
                  message.tabs.some(
                    (tab) => tab.id === initialTabId && !tab.active,
                  )
                ) {
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(
                      JSON.stringify({
                        type: "tab",
                        action: "switch",
                        tabId: initialTabId,
                      }),
                    );
                    setSentCount((value) => value + 1);
                  }
                }
              }

              syncUrlTabId(activeTab);
              console.log("[viewer-fe] websocket tabs", {
                sessionId,
                count: message.tabs.length,
                activeTab,
              });
            } else if (message.type === "navigation-state") {
              if (!knownTabIdsRef.current.has(message.state.tabId)) {
                return;
              }
              setNavigationByTabId((current) => ({
                ...current,
                [message.state.tabId]: message.state,
              }));
              console.log("[viewer-fe] websocket navigation state", {
                sessionId,
                state: message.state,
              });
            } else if (message.type === "cursor") {
              const canvas = canvasRef.current;
              if (canvas) {
                canvas.style.cursor = normalizeRemoteCursor(message.cursor);
              }
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
        if (canvasRef.current) {
          canvasRef.current.style.cursor = "default";
        }

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
      if (canvasElement) {
        canvasElement.style.cursor = "default";
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

        <div
          className="mb-3 flex flex-col gap-2 sm:flex-row"
          data-testid="navigation-bar"
        >
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              aria-label="Back"
              title="Back"
              disabled={!activeTabId || !activeNavigation?.canGoBack}
              onClick={() => {
                if (!activeTabId || !activeNavigation?.canGoBack) {
                  return;
                }
                sendInput({
                  type: "navigation",
                  action: "back",
                  tabId: activeTabId,
                });
              }}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant="secondary"
              aria-label="Forward"
              title="Forward"
              disabled={!activeTabId || !activeNavigation?.canGoForward}
              onClick={() => {
                if (!activeTabId || !activeNavigation?.canGoForward) {
                  return;
                }
                sendInput({
                  type: "navigation",
                  action: "forward",
                  tabId: activeTabId,
                });
              }}
            >
              <ArrowRight className="h-4 w-4" />
            </Button>
            {activeNavigation?.isLoading ? (
              <Button
                size="sm"
                variant="secondary"
                aria-label="Refresh"
                title="Refresh"
                disabled={!activeTabId}
                onClick={() => {
                  if (!activeTabId) {
                    return;
                  }
                  sendInput({
                    type: "navigation",
                    action: "stop",
                    tabId: activeTabId,
                  });
                }}
              >
                <RefreshCw className="h-4 w-4 animate-spin" />
              </Button>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                aria-label="Refresh"
                title="Refresh"
                disabled={!activeTabId}
                onClick={() => {
                  if (!activeTabId) {
                    return;
                  }
                  sendInput({
                    type: "navigation",
                    action: "reload",
                    tabId: activeTabId,
                  });
                }}
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            )}
          </div>

          <input
            data-testid="address-input"
            value={addressInput}
            onFocus={() => setIsEditingAddress(true)}
            onChange={(event) => setAddressInput(event.target.value)}
            onBlur={() => {
              setIsEditingAddress(false);
              setAddressInput(activeNavigation?.url ?? "");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submitNavigation();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setIsEditingAddress(false);
                setAddressInput(activeNavigation?.url ?? "");
              }
            }}
            className="h-9 flex-1 rounded-md border border-border bg-background px-3 text-sm outline-none ring-primary/30 transition focus:ring-2"
            placeholder="https://example.com"
          />
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
            onMouseLeave={() => {
              if (canvasRef.current) {
                canvasRef.current.style.cursor = "default";
              }
            }}
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
