import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleNavigationMessage } from "./navigation-handler";
import type { ConnectionContext } from "./context";
import * as navigationModule from "./navigation";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createState(): ConnectionContext {
  return {
    cdpSession: null,
    heartbeatTimer: null,
    isAlive: true,
    isClosed: false,
    activePage: {} as never,
    activeTabId: null,
    cursorLookupTimer: null,
    cursorLookupInFlight: false,
    pendingCursorPoint: null,
    lastCursorLookupAt: 0,
    lastCursorValue: "default",
    tabIdToPage: new Map(),
    pageToTabId: new WeakMap(),
    tabTitleById: new Map(),
    tabFaviconById: new Map(),
    pageListenersByTabId: new Map(),
    tabLoadingById: new Map(),
    devtoolsByTabId: new Map(),
  };
}

describe("handleNavigationMessage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends error when tab is missing", () => {
    const state = createState();
    const sendError = vi.fn();

    handleNavigationMessage(
      { type: "navigation", action: "reload", tabId: "missing" },
      {
        context: {} as never,
        state,
        sendError,
        sendAck: vi.fn(),
        emitNavigationState: vi.fn(async () => undefined),
      },
    );

    expect(sendError).toHaveBeenCalledWith("Unknown tabId: missing");
  });

  it("handles goto and sends ack", async () => {
    const state = createState();
    const page = {
      goto: vi.fn(async () => undefined),
      url: vi.fn(() => "https://example.com"),
    };
    state.tabIdToPage.set("tab-1", page as never);

    vi.spyOn(navigationModule, "normalizeNavigationUrl").mockReturnValue(
      "https://example.com",
    );
    const sendAck = vi.fn();
    const emitNavigationState = vi.fn(async () => undefined);
    const onNavigationRequested = vi.fn();
    const onNavigationSettled = vi.fn();

    handleNavigationMessage(
      {
        type: "navigation",
        action: "goto",
        tabId: "tab-1",
        url: "example.com",
      },
      {
        context: {} as never,
        state,
        sendError: vi.fn(),
        sendAck,
        emitNavigationState,
        onNavigationRequested,
        onNavigationSettled,
      },
    );

    await flushMicrotasks();
    expect(page.goto).toHaveBeenCalledWith("https://example.com", {
      waitUntil: "domcontentloaded",
    });
    expect(sendAck).toHaveBeenCalledTimes(1);
    expect(emitNavigationState).toHaveBeenCalled();
    expect(onNavigationRequested).toHaveBeenCalledWith(
      "tab-1",
      "example.com",
    );
    expect(onNavigationSettled).toHaveBeenCalledWith(
      "tab-1",
      "https://example.com",
    );
  });

  it("resets loading and reports error on failure", async () => {
    const state = createState();
    const page = {
      reload: vi.fn(async () => {
        throw new Error("reload failed");
      }),
    };
    state.tabIdToPage.set("tab-1", page as never);
    const sendError = vi.fn();

    handleNavigationMessage(
      { type: "navigation", action: "reload", tabId: "tab-1" },
      {
        context: {} as never,
        state,
        sendError,
        sendAck: vi.fn(),
        emitNavigationState: vi.fn(async () => undefined),
      },
    );

    await flushMicrotasks();
    expect(state.tabLoadingById.get("tab-1")).toBe(false);
    expect(sendError).toHaveBeenCalledWith("Error: reload failed");
  });
});
