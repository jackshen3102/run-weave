import http from "node:http";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { ViewerTab } from "@browser-viewer/shared";
import { attachWebSocketServer } from "./server";

class FakeCDPSession extends EventEmitter {
  private navigationHistory: {
    currentIndex: number;
    entries: Array<{ id: number; url: string }>;
  } = {
    currentIndex: 0,
    entries: [{ id: 1, url: "https://example.com" }],
  };

  setNavigationHistory(currentIndex: number, urls: string[]): void {
    this.navigationHistory = {
      currentIndex,
      entries: urls.map((url, index) => ({ id: index + 1, url })),
    };
  }

  send = vi.fn(async (method: string) => {
    if (method === "Page.getNavigationHistory") {
      return this.navigationHistory;
    }
    if (method === "DOM.getNodeForLocation") {
      return { nodeId: 1 };
    }
    if (method === "CSS.getComputedStyleForNode") {
      return { computedStyle: [{ name: "cursor", value: "pointer" }] };
    }
    return undefined;
  });
  detach = vi.fn(async () => undefined);
}

class FakePage extends EventEmitter {
  readonly mouse = {
    click: vi.fn(async () => undefined),
    move: vi.fn(async () => undefined),
    wheel: vi.fn(async () => undefined),
  };

  readonly keyboard = {
    press: vi.fn(async () => undefined),
  };

  readonly goBack = vi.fn(async () => undefined);
  readonly goForward = vi.fn(async () => undefined);
  readonly reload = vi.fn(async () => undefined);
  readonly stop = vi.fn(async () => undefined);
  readonly goto = vi.fn(async (url: string) => {
    this.currentUrl = url;
  });

  private readonly frame = {};

  constructor(
    private currentUrl: string,
    private currentTitle: string,
  ) {
    super();
  }

  url(): string {
    return this.currentUrl;
  }

  async title(): Promise<string> {
    return this.currentTitle;
  }

  mainFrame(): object {
    return this.frame;
  }

  setDocument(url: string, title: string): void {
    this.currentUrl = url;
    this.currentTitle = title;
    this.emit("framenavigated", this.frame);
    this.emit("load");
  }

  closePage(): void {
    this.emit("close");
  }
}

class FakeContext extends EventEmitter {
  private readonly pagesList: FakePage[];

  constructor(
    pages: FakePage[],
    private readonly cdpSession: FakeCDPSession,
  ) {
    super();
    this.pagesList = [...pages];
  }

  pages(): FakePage[] {
    return [...this.pagesList];
  }

  addPage(page: FakePage): void {
    this.pagesList.push(page);
    this.emit("page", page);
  }

  removePage(page: FakePage): void {
    const next = this.pagesList.filter((item) => item !== page);
    this.pagesList.splice(0, this.pagesList.length, ...next);
  }

  newCDPSession = vi.fn(async () => this.cdpSession);
}

function createJsonMessageQueue(socket: WebSocket) {
  const queue: Record<string, unknown>[] = [];
  const pendingResolvers: Array<(value: Record<string, unknown>) => void> = [];

  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      return;
    }

    const parsed = JSON.parse(String(data)) as Record<string, unknown>;
    const resolver = pendingResolvers.shift();
    if (resolver) {
      resolver(parsed);
      return;
    }
    queue.push(parsed);
  });

  return {
    next: (): Promise<Record<string, unknown>> => {
      const ready = queue.shift();
      if (ready) {
        return Promise.resolve(ready);
      }
      return new Promise((resolve) => pendingResolvers.push(resolve));
    },
    nextByType: async (type: string): Promise<Record<string, unknown>> => {
      for (;;) {
        const next = await (async () => {
          const ready = queue.shift();
          if (ready) {
            return ready;
          }
          return new Promise<Record<string, unknown>>((resolve) =>
            pendingResolvers.push(resolve),
          );
        })();
        if (next.type === type) {
          return next;
        }
      }
    },
  };
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

async function startServer(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve test server port");
  }

  return address.port;
}

async function stopServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function closeSocket(socket: WebSocket): Promise<void> {
  if (
    socket.readyState === WebSocket.CLOSED ||
    socket.readyState === WebSocket.CLOSING
  ) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    socket.once("close", () => resolve());
    socket.close();
  });
}

describe("websocket server", () => {
  const servers: http.Server[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    await Promise.all(
      sockets.map((socket) => closeSocket(socket).catch(() => undefined)),
    );
    sockets.length = 0;

    await Promise.all(servers.map((server) => stopServer(server)));
    servers.length = 0;
  });

  it("accepts session and applies input to active tab", async () => {
    const cdpSession = new FakeCDPSession();
    const page = new FakePage("https://example.com", "Example");
    const context = new FakeContext([page], cdpSession);

    const sessionManager = {
      getSession: vi.fn(() => ({
        id: "session-1",
        browserSession: {
          context,
          page,
        },
      })),
      markConnected: vi.fn(),
      destroySession: vi.fn(async () => true),
    };

    const server = http.createServer();
    servers.push(server);
    attachWebSocketServer(server, sessionManager as never);
    const port = await startServer(server);

    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws?sessionId=session-1`,
    );
    sockets.push(socket);
    const queue = createJsonMessageQueue(socket);

    await waitForOpen(socket);
    const connectedMessage = await queue.nextByType("connected");
    expect(connectedMessage.type).toBe("connected");

    const tabsMessage = await queue.nextByType("tabs");
    const tabs = tabsMessage.tabs as ViewerTab[];
    expect(tabs).toHaveLength(1);
    const firstTab = tabs.at(0);
    expect(firstTab).toBeDefined();
    expect(firstTab?.active).toBe(true);

    socket.send(
      JSON.stringify({
        type: "mouse",
        action: "click",
        x: 11,
        y: 22,
        button: "left",
      }),
    );
    const ackMessage = await queue.nextByType("ack");
    expect(ackMessage.type).toBe("ack");
    expect(page.mouse.click).toHaveBeenCalledWith(11, 22, { button: "left" });
  });

  it("switches between tabs and routes inputs to the active tab", async () => {
    const cdpSession = new FakeCDPSession();
    const pageA = new FakePage("https://a.example", "Page A");
    const context = new FakeContext([pageA], cdpSession);

    const sessionManager = {
      getSession: vi.fn(() => ({
        id: "session-2",
        browserSession: {
          context,
          page: pageA,
        },
      })),
      markConnected: vi.fn(),
      destroySession: vi.fn(async () => true),
    };

    const server = http.createServer();
    servers.push(server);
    attachWebSocketServer(server, sessionManager as never);
    const port = await startServer(server);

    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws?sessionId=session-2`,
    );
    sockets.push(socket);
    const queue = createJsonMessageQueue(socket);

    await waitForOpen(socket);
    await queue.nextByType("connected");
    const firstTabsMessage = await queue.nextByType("tabs");
    const firstTabs = firstTabsMessage.tabs as ViewerTab[];
    const firstTab = firstTabs.at(0);
    expect(firstTab).toBeDefined();
    const firstTabId = firstTab?.id;
    if (!firstTabId) {
      throw new Error("Missing first tab id");
    }

    const pageB = new FakePage("https://b.example", "Page B");
    context.addPage(pageB);

    let tabsAfterPopup = await queue.nextByType("tabs");
    let snapshot = tabsAfterPopup.tabs as ViewerTab[];
    if (snapshot.length < 2) {
      tabsAfterPopup = await queue.nextByType("tabs");
      snapshot = tabsAfterPopup.tabs as ViewerTab[];
    }

    expect(snapshot).toHaveLength(2);
    const secondTab = snapshot.find((tab) => tab.id !== firstTabId);
    expect(secondTab).toBeTruthy();

    socket.send(
      JSON.stringify({
        type: "tab",
        action: "switch",
        tabId: firstTabId,
      }),
    );

    const switchAck = await queue.nextByType("ack");
    expect(switchAck.eventType).toBe("tab");

    socket.send(
      JSON.stringify({
        type: "mouse",
        action: "click",
        x: 5,
        y: 9,
        button: "left",
      }),
    );

    const inputAck = await queue.nextByType("ack");
    expect(inputAck.eventType).toBe("mouse");
    expect(pageA.mouse.click).toHaveBeenCalledWith(5, 9, { button: "left" });
    expect(pageB.mouse.click).not.toHaveBeenCalledWith(5, 9, {
      button: "left",
    });
  });

  it("returns error on invalid tab id", async () => {
    const cdpSession = new FakeCDPSession();
    const page = new FakePage("https://example.com", "Example");
    const context = new FakeContext([page], cdpSession);

    const sessionManager = {
      getSession: vi.fn(() => ({
        id: "session-3",
        browserSession: {
          context,
          page,
        },
      })),
      markConnected: vi.fn(),
      destroySession: vi.fn(async () => true),
    };

    const server = http.createServer();
    servers.push(server);
    attachWebSocketServer(server, sessionManager as never);
    const port = await startServer(server);

    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws?sessionId=session-3`,
    );
    sockets.push(socket);
    const queue = createJsonMessageQueue(socket);

    await waitForOpen(socket);
    await queue.nextByType("connected");
    await queue.nextByType("tabs");

    socket.send(
      JSON.stringify({
        type: "tab",
        action: "switch",
        tabId: "tab-unknown",
      }),
    );

    const errorMessage = await queue.nextByType("error");
    expect(errorMessage.message).toBe("Unknown tabId: tab-unknown");
  });

  it("no-ops back/forward when history capability is unavailable", async () => {
    const cdpSession = new FakeCDPSession();
    cdpSession.setNavigationHistory(0, ["https://example.com"]);
    const page = new FakePage("https://example.com", "Example");
    const context = new FakeContext([page], cdpSession);

    const sessionManager = {
      getSession: vi.fn(() => ({
        id: "session-4a",
        browserSession: {
          context,
          page,
        },
      })),
      markConnected: vi.fn(),
      destroySession: vi.fn(async () => true),
    };

    const server = http.createServer();
    servers.push(server);
    attachWebSocketServer(server, sessionManager as never);
    const port = await startServer(server);

    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws?sessionId=session-4a`,
    );
    sockets.push(socket);
    const queue = createJsonMessageQueue(socket);

    await waitForOpen(socket);
    await queue.nextByType("connected");
    const tabsMessage = await queue.nextByType("tabs");
    const firstTab = (tabsMessage.tabs as ViewerTab[]).at(0);
    if (!firstTab) {
      throw new Error("Missing first tab");
    }

    socket.send(
      JSON.stringify({
        type: "navigation",
        action: "back",
        tabId: firstTab.id,
      }),
    );
    const backAck = await queue.nextByType("ack");
    expect(backAck.eventType).toBe("navigation");
    expect(page.goBack).not.toHaveBeenCalled();

    socket.send(
      JSON.stringify({
        type: "navigation",
        action: "forward",
        tabId: firstTab.id,
      }),
    );
    const forwardAck = await queue.nextByType("ack");
    expect(forwardAck.eventType).toBe("navigation");
    expect(page.goForward).not.toHaveBeenCalled();
  });

  it("handles navigation commands on active tab", async () => {
    const cdpSession = new FakeCDPSession();
    const page = new FakePage("https://example.com", "Example");
    const context = new FakeContext([page], cdpSession);

    const sessionManager = {
      getSession: vi.fn(() => ({
        id: "session-4",
        browserSession: {
          context,
          page,
        },
      })),
      markConnected: vi.fn(),
      destroySession: vi.fn(async () => true),
    };

    const server = http.createServer();
    servers.push(server);
    attachWebSocketServer(server, sessionManager as never);
    const port = await startServer(server);

    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws?sessionId=session-4`,
    );
    sockets.push(socket);
    const queue = createJsonMessageQueue(socket);

    await waitForOpen(socket);
    await queue.nextByType("connected");
    const tabsMessage = await queue.nextByType("tabs");
    const firstTab = (tabsMessage.tabs as ViewerTab[]).at(0);
    if (!firstTab) {
      throw new Error("Missing first tab");
    }

    socket.send(
      JSON.stringify({
        type: "navigation",
        action: "goto",
        tabId: firstTab.id,
        url: "example.com",
      }),
    );
    const gotoAck = await queue.nextByType("ack");
    expect(gotoAck.eventType).toBe("navigation");
    expect(page.goto).toHaveBeenCalledWith("https://example.com", {
      waitUntil: "domcontentloaded",
    });

    cdpSession.setNavigationHistory(1, [
      "https://example.com",
      "https://example.com/next",
    ]);
    socket.send(
      JSON.stringify({
        type: "navigation",
        action: "back",
        tabId: firstTab.id,
      }),
    );
    const backAck = await queue.nextByType("ack");
    expect(backAck.eventType).toBe("navigation");
    expect(page.goBack).toHaveBeenCalled();

    cdpSession.setNavigationHistory(0, [
      "https://example.com",
      "https://example.com/next",
    ]);
    socket.send(
      JSON.stringify({
        type: "navigation",
        action: "forward",
        tabId: firstTab.id,
      }),
    );
    const forwardAck = await queue.nextByType("ack");
    expect(forwardAck.eventType).toBe("navigation");
    expect(page.goForward).toHaveBeenCalled();

    socket.send(
      JSON.stringify({
        type: "navigation",
        action: "reload",
        tabId: firstTab.id,
      }),
    );
    const reloadAck = await queue.nextByType("ack");
    expect(reloadAck.eventType).toBe("navigation");
    expect(page.reload).toHaveBeenCalled();

    socket.send(
      JSON.stringify({
        type: "navigation",
        action: "stop",
        tabId: firstTab.id,
      }),
    );
    const stopAck = await queue.nextByType("ack");
    expect(stopAck.eventType).toBe("navigation");
    expect(cdpSession.send).toHaveBeenCalledWith("Page.stopLoading");

    socket.send(
      JSON.stringify({
        type: "mouse",
        action: "move",
        x: 50,
        y: 30,
      }),
    );

    let ackMessage: Record<string, unknown> | null = null;
    let cursorMessage: Record<string, unknown> | null = null;
    for (let i = 0; i < 10 && (!ackMessage || !cursorMessage); i += 1) {
      const message = await queue.next();
      if (message.type === "ack" && message.eventType === "mouse") {
        ackMessage = message;
      }
      if (message.type === "cursor") {
        cursorMessage = message;
      }
    }

    expect(ackMessage).toMatchObject({ type: "ack", eventType: "mouse" });
    expect(cursorMessage).toEqual({ type: "cursor", cursor: "pointer" });
  });
});
