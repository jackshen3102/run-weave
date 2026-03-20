import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createTabManager } from "./tab-manager";

class FakePage extends EventEmitter {
  constructor(private u: string, private t: string) {
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
    const page = new FakePage("https://example.com", "Example");
    const state = {
      activePage: page,
      activeTabId: null,
      tabCounter: 0,
      isClosed: false,
      tabIdToPage: new Map(),
      pageToTabId: new WeakMap(),
      tabTitleById: new Map(),
      tabLoadingById: new Map(),
      pageListenersByTabId: new Map(),
    } as never;

    const manager = createTabManager({
      state,
      sessionId: "s-1",
      context: { pages: () => [page] } as never,
      emitTabs: vi.fn(),
      emitCursor: vi.fn(),
      emitNavigationState: vi.fn(async () => undefined),
      startScreencast: vi.fn(async () => undefined),
      stopScreencast: vi.fn(async () => undefined),
      sendError: vi.fn(),
    });

    manager.initializeTabs(page);
    const tabId = state.activeTabId;
    expect(tabId).toBeTruthy();

    const switched = await manager.selectTab(String(tabId));
    expect(switched).toBe(true);
  });
});
