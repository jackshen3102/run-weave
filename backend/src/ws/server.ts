import type { Server as HttpServer } from "node:http";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { CDPSession, Frame, Page } from "playwright";
import type {
  ClientInputMessage,
  NavigationState,
  ServerEventMessage,
  ViewerTab,
} from "@browser-viewer/shared";
import { z } from "zod";
import type { SessionManager } from "../session/manager";
import { applyInputToPage } from "./input";

const clientInputSchema = z.union([
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
  z
    .object({
      type: z.literal("navigation"),
      action: z.union([
        z.literal("goto"),
        z.literal("back"),
        z.literal("forward"),
        z.literal("reload"),
        z.literal("stop"),
      ]),
      tabId: z.string().min(1),
      url: z.string().min(1).optional(),
    })
    .superRefine((value, ctx) => {
      if (value.action === "goto" && !value.url) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "url is required for goto action",
          path: ["url"],
        });
      }
    }),
]);

function parseClientMessage(raw: string): ClientInputMessage | null {
  try {
    const parsed = clientInputSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return null;
    }
    return parsed.data as ClientInputMessage;
  } catch {
    return null;
  }
}

export function attachWebSocketServer(
  server: HttpServer,
  sessionManager: SessionManager,
): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });
  let sampledMoveCount = 0;

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
    const tabLoadingById = new Map<string, boolean>();

    const hasScheme = (url: string): boolean =>
      /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(url);

    const normalizeNavigationUrl = (rawUrl: string): string => {
      const url = rawUrl.trim();
      if (!url) {
        throw new Error("URL is required");
      }
      return hasScheme(url) ? url : `https://${url}`;
    };

    const getNavigationHistory = async (
      page: Page,
    ): Promise<{ currentIndex: number; entryCount: number } | null> => {
      const tempSession = await session.browserSession.context.newCDPSession(page);
      try {
        const history = (await tempSession.send("Page.getNavigationHistory")) as {
          currentIndex: number;
          entries: Array<unknown>;
        };
        return { currentIndex: history.currentIndex, entryCount: history.entries.length };
      } catch {
        return null;
      } finally {
        await tempSession.detach().catch(() => undefined);
      }
    };

    const getNavigationCapability = async (
      page: Page,
    ): Promise<Pick<NavigationState, "canGoBack" | "canGoForward">> => {
      const history = await getNavigationHistory(page);
      if (!history) {
        return { canGoBack: false, canGoForward: false };
      }
      return {
        canGoBack: history.currentIndex > 0,
        canGoForward: history.currentIndex < history.entryCount - 1,
      };
    };

    const stopPageLoading = async (page: Page): Promise<void> => {
      const tempSession = await session.browserSession.context.newCDPSession(page);
      try {
        await tempSession.send("Page.stopLoading");
      } finally {
        await tempSession.detach().catch(() => undefined);
      }
    };

    const emitNavigationState = async (tabId: string): Promise<void> => {
      const page = tabIdToPage.get(tabId);
      if (!page) {
        return;
      }

      const capability = await getNavigationCapability(page);
      sendEvent(socket, {
        type: "navigation-state",
        state: {
          tabId,
          url: page.url(),
          isLoading: tabLoadingById.get(tabId) ?? false,
          canGoBack: capability.canGoBack,
          canGoForward: capability.canGoForward,
        },
      });
    };

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
      cdpSession.on("Page.screencastFrame", onScreencastFrame);
      await cdpSession.send("Page.startScreencast", {
        format: "jpeg",
        quality: 60,
        maxWidth: 1280,
        maxHeight: 720,
      });
      console.log("[viewer-be] screencast started", { sessionId, activeTabId });
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
      await emitNavigationState(tabId);

      await stopScreencast();
      await startScreencast();
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
      tabLoadingById.delete(tabId);

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
      tabLoadingById.set(tabId, false);

      const close = (): void => {
        unregisterPage(tabId);
      };
      const framenavigated = (frame: Frame): void => {
        if (frame === page.mainFrame()) {
          tabLoadingById.set(tabId, true);
          emitTabs();
          void emitNavigationState(tabId);
        }
      };
      const load = (): void => {
        tabLoadingById.set(tabId, false);
        void refreshTabTitle(tabId, page);
        void emitNavigationState(tabId);
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

      if (parsed.type === "navigation") {
        const targetPage = tabIdToPage.get(parsed.tabId);
        if (!targetPage) {
          sendEvent(socket, {
            type: "error",
            message: `Unknown tabId: ${parsed.tabId}`,
          });
          return;
        }

        tabLoadingById.set(parsed.tabId, parsed.action !== "stop");
        void emitNavigationState(parsed.tabId);

        void (async () => {
          if (parsed.action === "goto") {
            const normalizedUrl = normalizeNavigationUrl(parsed.url ?? "");
            await targetPage.goto(normalizedUrl, { waitUntil: "domcontentloaded" });
          } else if (parsed.action === "back") {
            const history = await getNavigationHistory(targetPage);
            if (history && history.currentIndex > 0) {
              await targetPage.goBack({ waitUntil: "domcontentloaded" });
            } else {
              tabLoadingById.set(parsed.tabId, false);
            }
          } else if (parsed.action === "forward") {
            const history = await getNavigationHistory(targetPage);
            if (history && history.currentIndex < history.entryCount - 1) {
              await targetPage.goForward({ waitUntil: "domcontentloaded" });
            } else {
              tabLoadingById.set(parsed.tabId, false);
            }
          } else if (parsed.action === "reload") {
            await targetPage.reload({ waitUntil: "domcontentloaded" });
          } else {
            await stopPageLoading(targetPage);
            tabLoadingById.set(parsed.tabId, false);
          }

          await emitNavigationState(parsed.tabId);
          sendEvent(socket, { type: "ack", eventType: parsed.type });
        })().catch((error) => {
          tabLoadingById.set(parsed.tabId, false);
          void emitNavigationState(parsed.tabId);
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
