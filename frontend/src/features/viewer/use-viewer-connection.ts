import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  type RefObject,
} from "react";
import type {
  ClientInputMessage,
  ServerEventMessage,
} from "@browser-viewer/shared";
import { normalizeRemoteCursor } from "../../lib/cursor";
import { createViewerWsTicket } from "../../services/session";
import { buildViewerWsUrl, getTabIdFromSearch, syncUrlTabId } from "./url";
import {
  initialViewerConnectionState,
  viewerConnectionReducer,
  type ViewerConnectionState,
  type ViewerConnectionStatus,
} from "./viewer-state";

interface UseViewerConnectionParams {
  apiBase: string;
  sessionId: string;
  token: string;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  onAuthExpired?: () => void;
}

interface UseViewerConnectionResult {
  status: ViewerConnectionStatus;
  error: string | null;
  sentCount: number;
  ackCount: number;
  tabs: ViewerConnectionState["tabs"];
  navigationByTabId: ViewerConnectionState["navigationByTabId"];
  devtoolsEnabled: boolean;
  devtoolsByTabId: ViewerConnectionState["devtoolsByTabId"];
  sendInput: (input: ClientInputMessage) => void;
  reconnect: () => void;
}

export function useViewerConnection({
  apiBase,
  sessionId,
  token,
  canvasRef,
  onAuthExpired,
}: UseViewerConnectionParams): UseViewerConnectionResult {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectCountRef = useRef(0);
  const connectedAtRef = useRef<number | null>(null);
  const wsCloseReasonRef = useRef<string | null>(null);
  const desiredTabIdRef = useRef<string | null>(
    getTabIdFromSearch(window.location.search),
  );
  const initialTabSyncedRef = useRef(false);

  const [connectNonce, setConnectNonce] = useReducer(
    (value: number) => value + 1,
    0,
  );
  const [state, dispatch] = useReducer(
    viewerConnectionReducer,
    initialViewerConnectionState,
  );

  const sendInput = useCallback((input: ClientInputMessage): void => {
    if (input.type === "tab" && input.action === "switch") {
      desiredTabIdRef.current = input.tabId;
      syncUrlTabId(input.tabId);
    }

    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }

    wsRef.current.send(JSON.stringify(input));
    dispatch({ type: "input/sent" });
  }, []);

  const reconnect = useCallback((): void => {
    reconnectCountRef.current = 0;
    connectedAtRef.current = null;
    wsCloseReasonRef.current = null;
    dispatch({ type: "connection/status", status: "connecting" });
    dispatch({ type: "connection/error", error: null });
    setConnectNonce();
  }, []);

  useEffect(() => {
    let closed = false;
    initialTabSyncedRef.current = false;
    const canvasElement = canvasRef.current;

    const syncInitialTabSelection = (
      ws: WebSocket,
      message: Extract<ServerEventMessage, { type: "tabs" }>,
    ): void => {
      if (initialTabSyncedRef.current || message.tabs.length === 0) {
        return;
      }
      initialTabSyncedRef.current = true;

      const initialTabId = desiredTabIdRef.current;
      if (
        !initialTabId ||
        ws.readyState !== WebSocket.OPEN ||
        !message.tabs.some((tab) => tab.id === initialTabId && !tab.active)
      ) {
        return;
      }

      ws.send(
        JSON.stringify({
          type: "tab",
          action: "switch",
          tabId: initialTabId,
        }),
      );
      dispatch({ type: "input/sent" });
    };

    const handleTabsMessage = (
      ws: WebSocket,
      message: Extract<ServerEventMessage, { type: "tabs" }>,
    ): void => {
      dispatch({ type: "message/tabs", tabs: message.tabs });
      syncInitialTabSelection(ws, message);

      const desiredTabId = desiredTabIdRef.current;
      if (desiredTabId && message.tabs.some((tab) => tab.id === desiredTabId)) {
        syncUrlTabId(desiredTabId);
        return;
      }

      const fallbackTabId =
        message.tabs.find((tab) => tab.active)?.id ?? message.tabs[0]?.id ?? null;
      desiredTabIdRef.current = fallbackTabId;
      syncUrlTabId(fallbackTabId);
    };

    const handleControlMessage = (
      ws: WebSocket,
      message: ServerEventMessage,
    ): void => {
      switch (message.type) {
        case "error": {
          wsCloseReasonRef.current = message.message;
          dispatch({ type: "connection/error", error: message.message });
          if (message.message === "Unauthorized") {
            onAuthExpired?.();
            return;
          }
          console.error("[viewer-fe] websocket control error", {
            sessionId,
            message: message.message,
          });
          return;
        }
        case "tabs":
          handleTabsMessage(ws, message);
          return;
        case "devtools-capability":
          dispatch({
            type: "message/devtools-capability",
            enabled: message.enabled,
          });
          return;
        case "devtools-state":
          dispatch({
            type: "message/devtools-state",
            tabId: message.tabId,
            opened: message.opened,
          });
          return;
        case "navigation-state":
          dispatch({
            type: "message/navigation-state",
            navigation: message.state,
          });
          return;
        case "cursor": {
          const canvas = canvasRef.current;
          if (canvas) {
            canvas.style.cursor = normalizeRemoteCursor(message.cursor);
          }
          return;
        }
        case "ack":
          dispatch({ type: "message/ack" });
          return;
        case "clipboard":
          if (message.action === "copy" && navigator.clipboard?.writeText) {
            void navigator.clipboard.writeText(message.text).catch(() => {
              console.error("[viewer-fe] failed to write clipboard", {
                sessionId,
              });
            });
          }
          return;
        default:
          return;
      }
    };

    const drawBinaryFrame = async (data: ArrayBuffer): Promise<void> => {
      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return;
      }

      const blob = new Blob([data], {
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

    const handleSocketClose = (
      ws: WebSocket,
      event: CloseEvent,
      connect: () => void,
    ): void => {
      const isCurrentSocket = wsRef.current === ws;
      if (isCurrentSocket) {
        wsRef.current = null;
      }
      if (closed) {
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
        dispatch({ type: "connection/status", status: "closed" });
        const closeReason =
          wsCloseReasonRef.current ||
          event.reason ||
          "WebSocket closed repeatedly. Please click Reconnect.";
        dispatch({ type: "connection/error", error: closeReason });
        if (closeReason === "Unauthorized") {
          onAuthExpired?.();
          return;
        }
        return;
      }

      dispatch({ type: "connection/status", status: "reconnecting" });
      const attempt = reconnectCountRef.current;
      const delay = Math.min(250 * 2 ** attempt, 5000);
      reconnectCountRef.current += 1;

      reconnectTimerRef.current = window.setTimeout(() => {
        void connect();
      }, delay);
    };

    const connect = async (): Promise<void> => {
      if (closed) {
        return;
      }

      let ticketPayload;
      try {
        ticketPayload = await createViewerWsTicket(apiBase, token, sessionId);
      } catch (error) {
        dispatch({
          type: "connection/error",
          error: String(error),
        });
        return;
      }

      if (closed) {
        return;
      }

      const ws = new WebSocket(
        buildViewerWsUrl(apiBase, sessionId, ticketPayload.ticket),
      );
      wsRef.current = ws;
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        if (wsRef.current !== ws) {
          return;
        }
        connectedAtRef.current = Date.now();
        wsCloseReasonRef.current = null;
        reconnectCountRef.current = 0;
        dispatch({ type: "connection/opened" });
      };

      ws.onmessage = async (event) => {
        if (wsRef.current !== ws) {
          return;
        }
        if (typeof event.data === "string") {
          try {
            handleControlMessage(
              ws,
              JSON.parse(event.data) as ServerEventMessage,
            );
          } catch {
            dispatch({
              type: "connection/error",
              error: "Received malformed control message.",
            });
            console.error("[viewer-fe] malformed control message", {
              sessionId,
              raw: event.data,
            });
          }
          return;
        }

        await drawBinaryFrame(event.data as ArrayBuffer);
      };

      ws.onerror = () => {
        if (wsRef.current !== ws) {
          return;
        }
        if (!closed) {
          dispatch({
            type: "connection/error",
            error: "WebSocket connection failed.",
          });
          console.error("[viewer-fe] websocket error", { sessionId });
        }
      };

      ws.onclose = (event) => {
        handleSocketClose(ws, event, connect);
      };
    };

    void connect();

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
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [apiBase, canvasRef, connectNonce, onAuthExpired, sessionId, token]);

  return {
    status: state.status,
    error: state.error,
    sentCount: state.sentCount,
    ackCount: state.ackCount,
    tabs: state.tabs,
    navigationByTabId: state.navigationByTabId,
    devtoolsEnabled: state.devtoolsEnabled,
    devtoolsByTabId: state.devtoolsByTabId,
    sendInput,
    reconnect,
  };
}
