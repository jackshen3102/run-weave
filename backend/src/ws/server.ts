import type { Server as HttpServer } from "node:http";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type {
  CollaborationState,
  ServerEventMessage,
} from "@browser-viewer/shared";
import type { SessionManager } from "../session/manager";
import type { AuthService } from "../auth/service";
import { QualityProbeStore } from "../quality/probe-store";
import { WebSocketSessionController } from "./session-control";
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
  options?: {
    devtoolsEnabled?: boolean;
    qualityProbeStore?: QualityProbeStore;
    wsSessionController?: WebSocketSessionController;
  },
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const devtoolsEnabled = options?.devtoolsEnabled ?? false;
  const qualityProbeStore = options?.qualityProbeStore;
  const wsSessionController = options?.wsSessionController;
  const cursorSyncIntervalMs = 50;

  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/ws") {
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

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
      tokenType: "viewer-ws",
    });

    if (!handshake.ok) {
      sendEvent(socket, { type: "error", message: handshake.errorMessage });
      socket.close(1008, handshake.closeReason);
      return;
    }

    const { sessionId, session } = handshake;
    const state = createConnectionContext(session.browserSession.page);
    wsSessionController?.register(sessionId, socket);
    const collaborationApi = sessionManager as Partial<
      Pick<
        SessionManager,
        | "getCollaborationState"
        | "onCollaborationTabSelected"
        | "onHumanInput"
        | "on"
        | "off"
      >
    >;

    const sendError = (message: string): void => {
      qualityProbeStore?.recordError(sessionId, "ws.runtime", message);
      sendEvent(socket, { type: "error", message });
    };

    const emitTabs = (): void => {
      const tabs = buildTabsSnapshot(
        sessionId,
        session.browserSession.context.pages(),
        state.pageToTabId,
        state.tabTitleById,
        state.tabFaviconById,
        state.activeTabId,
      );
      qualityProbeStore?.updateTabState(sessionId, {
        activeTabId: state.activeTabId,
        tabCount: tabs.length,
      });
      sendEvent(socket, {
        type: "tabs",
        tabs,
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

    const emitCollaborationState = (collaboration: CollaborationState): void => {
      sendEvent(socket, {
        type: "collaboration-state",
        collaboration,
      });
    };

    const syncCollaborationWithActiveTab = (): void => {
      if (!state.activeTabId) {
        return;
      }
      const current = collaborationApi.getCollaborationState?.(sessionId);
      if (current?.collaborationTabId === state.activeTabId) {
        return;
      }
      collaborationApi.onCollaborationTabSelected?.(sessionId, state.activeTabId);
    };

    const markHumanControl = (): void => {
      collaborationApi.onHumanInput?.(sessionId);
    };

    const screencast = createScreencastController({
      socket,
      state,
      context: session.browserSession.context,
      onFirstFrame: () => qualityProbeStore?.markFirstFrame(sessionId),
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
    const handleCollaborationUpdated = (
      changedSessionId: string,
      collaboration: CollaborationState,
    ): void => {
      if (changedSessionId !== sessionId) {
        return;
      }
      emitCollaborationState(collaboration);
    };

    sessionManager.markConnected(sessionId, true);
    collaborationApi.on?.("collaboration-updated", handleCollaborationUpdated);
    session.browserSession.context.on("page", tabManager.onContextPage);
    void tabManager
      .initializeTabs(session.browserSession.page)
      .then(() => {
        syncCollaborationWithActiveTab();
      })
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
    const initialCollaboration =
      collaborationApi.getCollaborationState?.(sessionId);
    if (initialCollaboration) {
      emitCollaborationState(initialCollaboration);
    }

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
          sendAck: () => {
            markHumanControl();
            syncCollaborationWithActiveTab();
            qualityProbeStore?.markInputAck(sessionId, parsed.type);
            sendEvent(socket, { type: "ack", eventType: parsed.type });
          },
        });
        return;
      }

      if (parsed.type === "navigation") {
        markHumanControl();
        handleNavigationMessage(parsed, {
          context: session.browserSession.context,
          state,
          sendError,
          sendAck: () => {
            qualityProbeStore?.markInputAck(sessionId, parsed.type);
            sendEvent(socket, { type: "ack", eventType: parsed.type });
          },
          emitNavigationState,
          onNavigationRequested: (tabId, url) => {
            qualityProbeStore?.markNavigationRequested(sessionId, {
              tabId,
              url,
            });
          },
          onNavigationSettled: (tabId, url) => {
            qualityProbeStore?.markNavigationSettled(sessionId, {
              tabId,
              url,
            });
          },
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
          sendAck: () => {
            qualityProbeStore?.markInputAck(sessionId, parsed.type);
            sendEvent(socket, { type: "ack", eventType: parsed.type });
          },
          emitDevtoolsState,
        });
        return;
      }

      markHumanControl();
      handlePageInputMessage({
        parsed,
        activePage: state.activePage,
        sessionId,
        sendError,
        sendAck: () => {
          qualityProbeStore?.markInputAck(sessionId, parsed.type);
          sendEvent(socket, { type: "ack", eventType: parsed.type });
        },
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
      collaborationApi.off?.("collaboration-updated", handleCollaborationUpdated);
      session.browserSession.context.off("page", tabManager.onContextPage);
      tabManager.disposePageListeners();
    };

    const closeConnection = (markDisconnected: boolean): void => {
      state.isClosed = true;
      cleanupConnection();
      wsSessionController?.unregister(sessionId, socket);
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
