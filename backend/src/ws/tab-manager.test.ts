import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { BrowserContext, Page } from "playwright";
import type { ConnectionContext } from "./context";
import { createTabManager } from "./tab-manager";

class FakePage extends EventEmitter {
  constructor(
    private u: string,
    private t: string,
  ) {
    super();
  }
  url(): string {
    return this.u;
  }
  async title(): Promise<string> {
    return this.t;
  }
  mainFrame(): object {
    return {};
  }
}

describe("createTabManager", () => {
  it("initializes tabs and can select existing tab", async () => {
    const fakePage = new FakePage("https://example.com", "Example");
    const page = fakePage as unknown as Page;

    const state: ConnectionContext = {
      cdpSession: null,
      heartbeatTimer: null,
      isAlive: true,
      isClosed: false,
      activePage: page,
      activeTabId: null,
      cursorLookupTimer: null,
      cursorLookupInFlight: false,
      pendingCursorPoint: null,
      lastCursorLookupAt: 0,
      lastCursorValue: "default",
      tabIdToPage: new Map(),
      pageToTabId: new WeakMap(),
      tabTitleById: new Map(),
      pageListenersByTabId: new Map(),
      tabLoadingById: new Map(),
      devtoolsByTabId: new Map(),
    };

    const context = {
      pages: () => [page],
      newCDPSession: vi.fn(async () => ({
        send: vi.fn(async () => ({ targetInfo: { targetId: "target-1" } })),
        detach: vi.fn(async () => undefined),
      })),
    } as unknown as BrowserContext;

    const manager = createTabManager({
      state,
      sessionId: "s-1",
      context,
      emitTabs: vi.fn(),
      emitCursor: vi.fn(),
      emitNavigationState: vi.fn(async () => undefined),
      startScreencast: vi.fn(async () => undefined),
      stopScreencast: vi.fn(async () => undefined),
      sendError: vi.fn(),
    } as never);

    await manager.initializeTabs(page as never);
    const tabId = state.activeTabId;
    expect(tabId).toBeTruthy();

    const switched = await manager.selectTab(String(tabId));
    expect(switched).toBe(true);
  });
});
