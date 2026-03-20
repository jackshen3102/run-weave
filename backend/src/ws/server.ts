import type { Server as HttpServer } from "node:http";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { ServerEventMessage } from "@browser-viewer/shared";
import type { SessionManager } from "../session/manager";
import type { AuthService } from "../auth/service";
import { parseClientMessage } from "./client-message";
import { getNavigationCapability } from "./navigation";
import { buildTabsSnapshot } from "./tabs";
import { createConnectionContext } from "./context";
import { createHeartbeatController } from "./heartbeat";
import { createScreencastController } from "./screencast";
import { createCursorSyncController } from "./cursor-sync";
import { createTabManager } from "./tab-manager";
import { handleNavigationMessage } from "./navigation-handler";
import { validateWebSocketHandshake } from "./handshake";
import { handleTabMessage } from "./tab-handler";
import { handlePageInputMessage } from "./input-handler";

export function attachWebSocketServer(
  server: HttpServer,
  sessionManager: SessionManager,
  authService: AuthService,
): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });
  let sampledMoveCount = 0;
  const cursorSyncIntervalMs = 50;

  const sendEvent = (socket: WebSocket, event: ServerEventMessage): void => {
    if (socket.readyState !== 1) {
      return;
    }
    socket.send(JSON.stringify(event));
  };

  wss.on("connection", (socket, request) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    console.log("[viewer-be] websocket connection incoming", {
      url: request.url,
      sessionId: requestUrl.searchParams.get("sessionId"),
    });

    const handshake = validateWebSocketHandshake({
      request,
      authService,
      sessionManager,
    });

    if (!handshake.ok) {
      if (handshake.logMeta) {
        console.log(handshake.logMessage, handshake.logMeta);
      } else {
        console.log(handshake.logMessage);
      }
      sendEvent(socket, { type: "error", message: handshake.errorMessage });
      socket.close(1008, handshake.closeReason);
      return;
    }

    const { sessionId, session } = handshake;
    const state = createConnectionContext(session.browserSession.page);

    const sendError = (message: string): void => {
      sendEvent(socket, { type: "error", message });
    };

    const emitTabs = (): void => {
      sendEvent(socket, {
        type: "tabs",
        tabs: buildTabsSnapshot(
          state.tabIdToPage,
          state.tabTitleById,
          state.activeTabId,
        ),
      });
    };

    const emitNavigationState = async (tabId: string): Promise<void> => {
      const page = state.tabIdToPage.get(tabId);
      if (!page) {
        return;
      }

      const capability = await getNavigationCapability(
        session.browserSession.context,
        page,
      );
      sendEvent(socket, {
        type: "navigation-state",
        state: {
          tabId,
          url: page.url(),
          isLoading: state.tabLoadingById.get(tabId) ?? false,
          canGoBack: capability.canGoBack,
          canGoForward: capability.canGoForward,
        },
      });
    };

    const emitCursor = (cursor: string): void => {
      if (cursor === state.lastCursorValue) {
        return;
      }
      state.lastCursorValue = cursor;
      sendEvent(socket, { type: "cursor", cursor });
    };

    const screencast = createScreencastController({
      socket,
      state,
      context: session.browserSession.context,
      sessionId,
    });

    const cursorSync = createCursorSyncController({
      state,
      cursorSyncIntervalMs,
      emitCursor,
    });

    const tabManager = createTabManager({
      state,
      sessionId,
      context: session.browserSession.context,
      emitTabs,
      emitCursor,
      emitNavigationState,
      startScreencast: screencast.start,
      stopScreencast: screencast.stop,
      sendError,
    });

    const heartbeat = createHeartbeatController(socket, state);

    sessionManager.markConnected(sessionId, true);
    session.browserSession.context.on("page", tabManager.onContextPage);
    tabManager.initializeTabs(session.browserSession.page);
    heartbeat.start();

    sendEvent(socket, { type: "connected", sessionId });
    emitTabs();
    console.log("[viewer-be] websocket connected", { sessionId });

    void screencast.start().catch((error) => {
      sendError(String(error));
      console.log("[viewer-be] failed to start screencast", {
        sessionId,
        error: String(error),
      });
      socket.close(1011, "Failed to start screencast");
    });

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        return;
      }

      const parsed = parseClientMessage(String(data));
      if (!parsed) {
        console.log("[viewer-be] invalid client message", {
          sessionId,
          raw: String(data),
        });
        sendError("Invalid message");
        return;
      }

      if (parsed.type === "mouse" && parsed.action === "move") {
        sampledMoveCount += 1;
        if (sampledMoveCount % 30 === 0) {
          console.log("[viewer-be] input mouse move (sampled)", {
            sessionId,
            count: sampledMoveCount,
            x: parsed.x,
            y: parsed.y,
          });
        }
      } else {
        console.log("[viewer-be] input received", { sessionId, input: parsed });
      }

      if (parsed.type === "tab") {
        handleTabMessage({
          parsed,
          selectTab: tabManager.selectTab,
          sendError,
          sendAck: () => sendEvent(socket, { type: "ack", eventType: parsed.type }),
        });
        return;
      }

      if (parsed.type === "navigation") {
        handleNavigationMessage(parsed, {
          context: session.browserSession.context,
          state,
          sendError,
          sendAck: () => sendEvent(socket, { type: "ack", eventType: parsed.type }),
          emitNavigationState,
        });
        return;
      }

      handlePageInputMessage({
        parsed,
        activePage: state.activePage,
        sessionId,
        sendError,
        sendAck: () => sendEvent(socket, { type: "ack", eventType: parsed.type }),
        scheduleCursorLookup: cursorSync.scheduleLookup,
      });
    });

    const cleanupConnection = (): void => {
      heartbeat.stop();
      cursorSync.dispose();
      void screencast.stop();
      session.browserSession.context.off("page", tabManager.onContextPage);
      tabManager.disposePageListeners();
    };

    socket.on("close", () => {
      state.isClosed = true;
      cleanupConnection();
      sessionManager.markConnected(sessionId, false);
      console.log("[viewer-be] websocket closed", { sessionId });
    });

    socket.on("error", () => {
      state.isClosed = true;
      cleanupConnection();
      console.log("[viewer-be] websocket error", { sessionId });
    });

    socket.on("pong", () => {
      heartbeat.markAlive();
    });
  });

  return wss;
}
