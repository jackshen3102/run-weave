import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type RefObject,
} from "react";
import type {
  ClientInputMessage,
  ServerEventMessage,
} from "@browser-viewer/shared";
import { normalizeRemoteCursor } from "../../lib/cursor";
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
  const moveLogCounterRef = useRef(0);
  const initialTabIdRef = useRef<string | null>(
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

  const wsUrl = useMemo(
    () => buildViewerWsUrl(apiBase, sessionId, token),
    [apiBase, sessionId, token],
  );

  const sendInput = useCallback(
    (input: ClientInputMessage): void => {
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
      dispatch({ type: "input/sent" });
    },
    [sessionId],
  );

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

      const initialTabId = initialTabIdRef.current;
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

      const activeTab = message.tabs.find((tab) => tab.active)?.id ?? null;
      syncUrlTabId(activeTab);
      console.log("[viewer-fe] websocket tabs", {
        sessionId,
        count: message.tabs.length,
        activeTab,
      });
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
          console.log("[viewer-fe] websocket control error", {
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
          console.log("[viewer-fe] websocket navigation state", {
            sessionId,
            state: message.state,
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
          console.log("[viewer-fe] websocket ack", {
            sessionId,
            eventType: message.eventType,
          });
          return;
        default:
          console.log("[viewer-fe] websocket control message", {
            sessionId,
            message,
          });
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
        console.log("[viewer-fe] websocket closed, stop auto reconnect", {
          sessionId,
          code: event.code,
          reason: event.reason,
          eventMessage: wsCloseReasonRef.current,
          livedMs,
        });
        return;
      }

      dispatch({ type: "connection/status", status: "reconnecting" });
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
        dispatch({ type: "connection/opened" });
        console.log("[viewer-fe] websocket connected", { sessionId });
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
            console.log("[viewer-fe] malformed control message", {
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
          console.log("[viewer-fe] websocket error", { sessionId });
        }
      };

      ws.onclose = (event) => {
        handleSocketClose(ws, event, connect);
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
  }, [canvasRef, connectNonce, onAuthExpired, sessionId, wsUrl]);

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
