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
import { handleDevtoolsMessage } from "./devtools-handler";

export function attachWebSocketServer(
  server: HttpServer,
  sessionManager: SessionManager,
  authService: AuthService,
  options?: { devtoolsEnabled?: boolean },
): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });
  const devtoolsEnabled = options?.devtoolsEnabled ?? false;
  const cursorSyncIntervalMs = 50;

  const sendEvent = (socket: WebSocket, event: ServerEventMessage): void => {
    if (socket.readyState !== 1) {
      return;
    }
    socket.send(JSON.stringify(event));
  };

  wss.on("connection", (socket, request) => {
    const handshake = validateWebSocketHandshake({
      request,
      authService,
      sessionManager,
    });

    if (!handshake.ok) {
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
          session.browserSession.context.pages(),
          state.pageToTabId,
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

    const emitDevtoolsState = (tabId: string, opened: boolean): void => {
      sendEvent(socket, { type: "devtools-state", tabId, opened });
    };

    const screencast = createScreencastController({
      socket,
      state,
      context: session.browserSession.context,
    });

    const cursorSync = createCursorSyncController({
      state,
      cursorSyncIntervalMs,
      emitCursor,
    });

    const tabManager = createTabManager({
      state,
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
    void tabManager
      .initializeTabs(session.browserSession.page)
      .catch((error) => {
        sendError(String(error));
        console.error("[viewer-be] failed to initialize tabs", {
          sessionId,
          error: String(error),
        });
        socket.close(1011, "Failed to initialize tabs");
      });
    heartbeat.start();

    sendEvent(socket, { type: "connected", sessionId });
    sendEvent(socket, {
      type: "devtools-capability",
      enabled: devtoolsEnabled,
    });

    void screencast.start().catch((error) => {
      sendError(String(error));
      console.error("[viewer-be] failed to start screencast", {
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
        sendError("Invalid message");
        return;
      }

      if (parsed.type === "tab") {
        handleTabMessage({
          parsed,
          createTab: tabManager.createTab,
          closeTab: tabManager.closeTab,
          selectTab: tabManager.selectTab,
          sendError,
          sendAck: () =>
            sendEvent(socket, { type: "ack", eventType: parsed.type }),
        });
        return;
      }

      if (parsed.type === "navigation") {
        handleNavigationMessage(parsed, {
          context: session.browserSession.context,
          state,
          sendError,
          sendAck: () =>
            sendEvent(socket, { type: "ack", eventType: parsed.type }),
          emitNavigationState,
        });
        return;
      }

      if (parsed.type === "devtools") {
        if (!devtoolsEnabled) {
          sendError("DevTools is disabled");
          return;
        }

        handleDevtoolsMessage(parsed, {
          state,
          sendError,
          sendAck: () =>
            sendEvent(socket, { type: "ack", eventType: parsed.type }),
          emitDevtoolsState,
        });
        return;
      }

      handlePageInputMessage({
        parsed,
        activePage: state.activePage,
        sessionId,
        sendError,
        sendAck: () =>
          sendEvent(socket, { type: "ack", eventType: parsed.type }),
        sendClipboardCopy: (text) =>
          sendEvent(socket, {
            type: "clipboard",
            action: "copy",
            text,
          }),
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

    const closeConnection = (markDisconnected: boolean): void => {
      state.isClosed = true;
      cleanupConnection();
      if (markDisconnected) {
        sessionManager.markConnected(sessionId, false);
      }
    };

    socket.on("close", () => {
      closeConnection(true);
    });

    socket.on("error", () => {
      closeConnection(false);
    });

    socket.on("pong", () => {
      heartbeat.markAlive();
    });
  });

  return wss;
}
