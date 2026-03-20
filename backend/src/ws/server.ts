import type { Server as HttpServer } from "node:http";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { CDPSession, Frame, Page } from "playwright";
import type {
  ClientInputMessage,
  ServerEventMessage,
  ViewerTab,
} from "@browser-viewer/shared";
import { z } from "zod";
import type { SessionManager } from "../session/manager";
import { applyInputToPage } from "./input";

const clientInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("mouse"),
    action: z.union([z.literal("click"), z.literal("move")]),
    x: z.number(),
    y: z.number(),
    button: z
      .union([z.literal("left"), z.literal("middle"), z.literal("right")])
      .optional(),
  }),
  z.object({
    type: z.literal("keyboard"),
    key: z.string().min(1),
    modifiers: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal("scroll"),
    x: z.number().optional(),
    y: z.number().optional(),
    deltaX: z.number(),
    deltaY: z.number(),
  }),
  z.object({
    type: z.literal("tab"),
    action: z.literal("switch"),
    tabId: z.string().min(1),
  }),
]);

function parseClientMessage(raw: string): ClientInputMessage | null {
  try {
    const parsed = clientInputSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

function normalizeCursor(cursor: string | undefined): string {
  if (!cursor || cursor === "auto") {
    return "default";
  }
  if (cursor.startsWith("url(")) {
    return "default";
  }
  return cursor;
}

async function resolveCursorAtPoint(
  cdpSession: CDPSession,
  x: number,
  y: number,
): Promise<string> {
  const location = await cdpSession.send("DOM.getNodeForLocation", {
    x,
    y,
    includeUserAgentShadowDOM: true,
    ignorePointerEventsNone: false,
  });

  let nodeId =
    typeof location?.nodeId === "number" ? (location.nodeId as number) : null;

  if (!nodeId && typeof location?.backendNodeId === "number") {
    const pushed = await cdpSession.send(
      "DOM.pushNodesByBackendIdsToFrontend",
      {
        backendNodeIds: [location.backendNodeId],
      },
    );
    const pushedNodeId = Array.isArray(pushed?.nodeIds)
      ? pushed.nodeIds[0]
      : null;
    nodeId = typeof pushedNodeId === "number" ? pushedNodeId : null;
  }

  if (!nodeId) {
    return "default";
  }

  const computed = await cdpSession.send("CSS.getComputedStyleForNode", {
    nodeId,
  });
  const computedStyle = Array.isArray(computed?.computedStyle)
    ? computed.computedStyle
    : [];
  const cursorEntry = computedStyle.find(
    (entry: unknown) =>
      typeof entry === "object" &&
      entry !== null &&
      "name" in entry &&
      "value" in entry &&
      (entry as { name: unknown }).name === "cursor",
  ) as { value?: string } | undefined;

  return normalizeCursor(cursorEntry?.value);
}

export function attachWebSocketServer(
  server: HttpServer,
  sessionManager: SessionManager,
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
    const sessionId = requestUrl.searchParams.get("sessionId");
    console.log("[viewer-be] websocket connection incoming", {
      url: request.url,
      sessionId,
    });

    if (!sessionId) {
      console.log("[viewer-be] websocket rejected: missing sessionId");
      sendEvent(socket, { type: "error", message: "Missing sessionId" });
      socket.close(1008, "Missing sessionId");
      return;
    }

    const session = sessionManager.getSession(sessionId);
    if (!session) {
      console.log("[viewer-be] websocket rejected: session not found", {
        sessionId,
      });
      sendEvent(socket, { type: "error", message: "Session not found" });
      socket.close(1008, "Session not found");
      return;
    }

    let cdpSession: CDPSession | null = null;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    let isAlive = true;
    let isClosed = false;
    let activePage: Page = session.browserSession.page;
    let activeTabId: string | null = null;
    let tabCounter = 0;
    let cursorLookupTimer: NodeJS.Timeout | null = null;
    let cursorLookupInFlight = false;
    let pendingCursorPoint: { x: number; y: number } | null = null;
    let lastCursorLookupAt = 0;
    let lastCursorValue = "default";

    const tabIdToPage = new Map<string, Page>();
    const pageToTabId = new WeakMap<Page, string>();
    const tabTitleById = new Map<string, string>();
    const pageListenersByTabId = new Map<
      string,
      {
        close: () => void;
        framenavigated: (frame: Frame) => void;
        load: () => void;
      }
    >();

    const buildTabsSnapshot = (): ViewerTab[] => {
      return Array.from(tabIdToPage.entries()).map(([id, page]) => ({
        id,
        url: page.url(),
        title: tabTitleById.get(id) ?? page.url(),
        active: id === activeTabId,
      }));
    };

    const emitTabs = (): void => {
      sendEvent(socket, {
        type: "tabs",
        tabs: buildTabsSnapshot(),
      });
    };

    const emitCursor = (cursor: string): void => {
      if (cursor === lastCursorValue) {
        return;
      }
      lastCursorValue = cursor;
      sendEvent(socket, { type: "cursor", cursor });
    };

    const onScreencastFrame = (payload: {
      data: string;
      sessionId: number;
    }): void => {
      if (socket.readyState !== 1) {
        return;
      }

      const frameBuffer = Buffer.from(payload.data, "base64");
      socket.send(frameBuffer, { binary: true });
      void cdpSession?.send("Page.screencastFrameAck", {
        sessionId: payload.sessionId,
      });
    };

    const startScreencast = async (): Promise<void> => {
      cdpSession =
        await session.browserSession.context.newCDPSession(activePage);
      await cdpSession.send("DOM.enable");
      await cdpSession.send("CSS.enable");
      cdpSession.on("Page.screencastFrame", onScreencastFrame);
      await cdpSession.send("Page.startScreencast", {
        format: "jpeg",
        quality: 60,
        maxWidth: 1280,
        maxHeight: 720,
      });
      console.log("[viewer-be] screencast started", { sessionId, activeTabId });
    };

    const runCursorLookup = async (): Promise<void> => {
      if (!cdpSession || cursorLookupInFlight || !pendingCursorPoint) {
        return;
      }

      const point = pendingCursorPoint;
      pendingCursorPoint = null;
      cursorLookupInFlight = true;
      lastCursorLookupAt = Date.now();

      try {
        const cursor = await resolveCursorAtPoint(cdpSession, point.x, point.y);
        emitCursor(cursor);
      } catch {
        emitCursor("default");
      } finally {
        cursorLookupInFlight = false;
      }

      if (pendingCursorPoint && !cursorLookupTimer) {
        const elapsed = Date.now() - lastCursorLookupAt;
        const delay = Math.max(0, cursorSyncIntervalMs - elapsed);
        cursorLookupTimer = setTimeout(() => {
          cursorLookupTimer = null;
          void runCursorLookup();
        }, delay);
        cursorLookupTimer.unref?.();
      }
    };

    const scheduleCursorLookup = (x: number, y: number): void => {
      pendingCursorPoint = { x, y };
      if (!cdpSession || cursorLookupInFlight || cursorLookupTimer) {
        return;
      }

      const elapsed = Date.now() - lastCursorLookupAt;
      const delay = Math.max(0, cursorSyncIntervalMs - elapsed);
      cursorLookupTimer = setTimeout(() => {
        cursorLookupTimer = null;
        void runCursorLookup();
      }, delay);
      cursorLookupTimer.unref?.();
    };

    const stopScreencast = async (): Promise<void> => {
      if (!cdpSession) {
        return;
      }

      cdpSession.off("Page.screencastFrame", onScreencastFrame);
      await cdpSession.send("Page.stopScreencast").catch(() => undefined);
      await cdpSession.detach().catch(() => undefined);
      cdpSession = null;
      console.log("[viewer-be] screencast stopped", { sessionId, activeTabId });
    };

    const refreshTabTitle = async (
      tabId: string,
      page: Page,
    ): Promise<void> => {
      try {
        const title = await page.title();
        tabTitleById.set(tabId, title || page.url());
      } catch {
        tabTitleById.set(tabId, page.url());
      }
      emitTabs();
    };

    const selectTab = async (tabId: string): Promise<boolean> => {
      const nextPage = tabIdToPage.get(tabId);
      if (!nextPage) {
        return false;
      }

      activeTabId = tabId;
      activePage = nextPage;
      emitTabs();

      await stopScreencast();
      await startScreencast();
      emitCursor("default");
      return true;
    };

    const selectLastTab = async (): Promise<void> => {
      const fallbackTabId = Array.from(tabIdToPage.keys()).at(-1);
      if (!fallbackTabId) {
        activeTabId = null;
        emitTabs();
        await stopScreencast();
        return;
      }
      await selectTab(fallbackTabId);
    };

    const unregisterPage = (tabId: string): void => {
      const page = tabIdToPage.get(tabId);
      if (!page) {
        return;
      }

      const listeners = pageListenersByTabId.get(tabId);
      if (listeners) {
        page.off("close", listeners.close);
        page.off("framenavigated", listeners.framenavigated);
        page.off("load", listeners.load);
      }

      pageListenersByTabId.delete(tabId);
      tabIdToPage.delete(tabId);
      tabTitleById.delete(tabId);

      if (activeTabId === tabId && !isClosed) {
        void selectLastTab().catch((error) => {
          sendEvent(socket, { type: "error", message: String(error) });
        });
      } else {
        emitTabs();
      }
    };

    const registerPage = (page: Page): string => {
      const existing = pageToTabId.get(page);
      if (existing) {
        return existing;
      }

      const tabId = `tab-${++tabCounter}`;
      pageToTabId.set(page, tabId);
      tabIdToPage.set(tabId, page);
      tabTitleById.set(tabId, page.url() || "about:blank");

      const close = (): void => {
        unregisterPage(tabId);
      };
      const framenavigated = (frame: Frame): void => {
        if (frame === page.mainFrame()) {
          emitTabs();
        }
      };
      const load = (): void => {
        void refreshTabTitle(tabId, page);
      };

      pageListenersByTabId.set(tabId, { close, framenavigated, load });
      page.on("close", close);
      page.on("framenavigated", framenavigated);
      page.on("load", load);

      void refreshTabTitle(tabId, page);
      emitTabs();
      return tabId;
    };

    const onContextPage = (page: Page): void => {
      const tabId = registerPage(page);
      void selectTab(tabId)
        .then(() => {
          console.log("[viewer-be] switched to new tab", { sessionId, tabId });
        })
        .catch((error) => {
          sendEvent(socket, { type: "error", message: String(error) });
        });
    };

    const startHeartbeat = (): void => {
      heartbeatTimer = setInterval(() => {
        if (socket.readyState !== 1) {
          return;
        }

        if (!isAlive) {
          socket.terminate();
          return;
        }

        isAlive = false;
        socket.ping();
      }, 15_000);
      heartbeatTimer.unref?.();
    };

    const stopHeartbeat = (): void => {
      if (!heartbeatTimer) {
        return;
      }
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    };

    sessionManager.markConnected(sessionId, true);
    session.browserSession.context.on("page", onContextPage);
    for (const page of session.browserSession.context.pages()) {
      registerPage(page);
    }
    const initialTabId =
      pageToTabId.get(session.browserSession.page) ??
      Array.from(tabIdToPage.keys())[0];
    if (initialTabId) {
      activeTabId = initialTabId;
      activePage = tabIdToPage.get(initialTabId) ?? activePage;
    }
    startHeartbeat();
    sendEvent(socket, { type: "connected", sessionId });
    emitTabs();
    console.log("[viewer-be] websocket connected", { sessionId });
    void startScreencast().catch((error) => {
      sendEvent(socket, { type: "error", message: String(error) });
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
        sendEvent(socket, { type: "error", message: "Invalid message" });
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
        void selectTab(parsed.tabId)
          .then((switched) => {
            if (!switched) {
              sendEvent(socket, {
                type: "error",
                message: `Unknown tabId: ${parsed.tabId}`,
              });
              return;
            }
            sendEvent(socket, { type: "ack", eventType: parsed.type });
          })
          .catch((error) => {
            sendEvent(socket, { type: "error", message: String(error) });
          });
        return;
      }

      void applyInputToPage(activePage, parsed)
        .then(() => {
          console.log("[viewer-be] input applied", {
            sessionId,
            eventType: parsed.type,
          });
          sendEvent(socket, { type: "ack", eventType: parsed.type });
          if (parsed.type === "mouse" && parsed.action === "move") {
            scheduleCursorLookup(parsed.x, parsed.y);
          }
        })
        .catch((error) => {
          console.log("[viewer-be] input apply failed", {
            sessionId,
            eventType: parsed.type,
            error: String(error),
          });
          sendEvent(socket, { type: "error", message: String(error) });
        });
    });

    socket.on("close", () => {
      isClosed = true;
      stopHeartbeat();
      if (cursorLookupTimer) {
        clearTimeout(cursorLookupTimer);
        cursorLookupTimer = null;
      }
      void stopScreencast();
      session.browserSession.context.off("page", onContextPage);
      for (const [tabId, listeners] of pageListenersByTabId.entries()) {
        const page = tabIdToPage.get(tabId);
        if (!page) {
          continue;
        }
        page.off("close", listeners.close);
        page.off("framenavigated", listeners.framenavigated);
        page.off("load", listeners.load);
      }
      pageListenersByTabId.clear();
      sessionManager.markConnected(sessionId, false);
      console.log("[viewer-be] websocket closed", { sessionId });
    });

    socket.on("error", () => {
      isClosed = true;
      stopHeartbeat();
      if (cursorLookupTimer) {
        clearTimeout(cursorLookupTimer);
        cursorLookupTimer = null;
      }
      void stopScreencast();
      session.browserSession.context.off("page", onContextPage);
      console.log("[viewer-be] websocket error", { sessionId });
    });

    socket.on("pong", () => {
      isAlive = true;
    });
  });

  return wss;
}
