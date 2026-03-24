import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { connectOverCDP, launchPersistentContext } = vi.hoisted(() => ({
  connectOverCDP: vi.fn(),
  launchPersistentContext: vi.fn(),
}));

vi.mock("playwright-extra", () => ({
  chromium: {
    connectOverCDP,
    launchPersistentContext,
  },
}));

import { BrowserService } from "./service";

vi.mock("../server/listen", () => ({
  findAvailablePort: vi.fn(async (startPort: number) => startPort),
}));

function createBrowserContextMock() {
  return {
    close: vi.fn(async () => undefined),
    pages: vi.fn(() => []),
    newPage: vi.fn(async () => ({
      close: vi.fn(async () => undefined),
      goto: vi.fn(async () => undefined),
      url: vi.fn(() => "about:blank"),
    })),
    on: vi.fn(),
  };
}

describe("BrowserService", () => {
  beforeEach(() => {
    connectOverCDP.mockReset();
    launchPersistentContext.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("launches proxied session contexts with whistle settings", async () => {
    const context = createBrowserContextMock();
    launchPersistentContext.mockResolvedValue(context);
    const service = new BrowserService({
      headless: true,
      profileDir: "/tmp/browser-profiles",
    });

    await service.createSession("session-proxy", "https://example.com", {
      type: "launch",
      profilePath: "/tmp/browser-profiles/sessions/session-proxy",
      proxyEnabled: true,
      headers: {},
    });

    expect(launchPersistentContext).toHaveBeenCalledWith(
      "/tmp/browser-profiles/sessions/session-proxy",
      expect.objectContaining({
        headless: true,
        proxy: {
          bypass: "127.0.0.1,localhost",
          server: "http://127.0.0.1:8899",
        },
      }),
    );
  });

  it("launches direct session contexts without proxy settings", async () => {
    const context = createBrowserContextMock();
    launchPersistentContext.mockResolvedValue(context);
    const service = new BrowserService({
      headless: true,
      profileDir: "/tmp/browser-profiles",
    });

    await service.createSession("session-direct", "https://example.com", {
      type: "launch",
      profilePath: "/tmp/browser-profiles/sessions/session-direct",
      proxyEnabled: false,
      headers: {},
    });

    expect(launchPersistentContext).toHaveBeenCalledWith(
      "/tmp/browser-profiles/sessions/session-direct",
      expect.not.objectContaining({
        proxy: expect.anything(),
      }),
    );
  });

  it("applies per-session headers to persistent contexts", async () => {
    const context = createBrowserContextMock();
    launchPersistentContext.mockResolvedValue(context);
    const service = new BrowserService({
      headless: true,
      profileDir: "/tmp/browser-profiles",
    });

    await service.createSession("session-headers", "https://example.com", {
      type: "launch",
      profilePath: "/tmp/browser-profiles/sessions/session-headers",
      proxyEnabled: false,
      headers: {
        "x-session-id": "session-headers",
        authorization: "Bearer demo",
      },
    });

    expect(launchPersistentContext).toHaveBeenCalledWith(
      "/tmp/browser-profiles/sessions/session-headers",
      expect.objectContaining({
        extraHTTPHeaders: {
          "x-session-id": "session-headers",
          authorization: "Bearer demo",
        },
      }),
    );
  });

  it("assigns distinct remote debugging ports per session when devtools are enabled", async () => {
    launchPersistentContext
      .mockResolvedValueOnce(createBrowserContextMock())
      .mockResolvedValueOnce(createBrowserContextMock());
    const service = new BrowserService({
      devtoolsEnabled: true,
      headless: true,
      profileDir: "/tmp/browser-profiles",
      remoteDebuggingPort: 9222,
    });

    await service.createSession("session-a", "https://example.com", {
      type: "launch",
      profilePath: "/tmp/browser-profiles/sessions/session-a",
      proxyEnabled: false,
      headers: {},
    });
    await service.createSession("session-b", "https://example.com", {
      type: "launch",
      profilePath: "/tmp/browser-profiles/sessions/session-b",
      proxyEnabled: false,
      headers: {},
    });

    expect(service.getRemoteDebuggingPort("session-a")).toBe(9222);
    expect(service.getRemoteDebuggingPort("session-b")).toBe(9223);
    expect(launchPersistentContext).toHaveBeenNthCalledWith(
      1,
      "/tmp/browser-profiles/sessions/session-a",
      expect.objectContaining({
        args: expect.arrayContaining(["--remote-debugging-port=9222"]),
      }),
    );
    expect(launchPersistentContext).toHaveBeenNthCalledWith(
      2,
      "/tmp/browser-profiles/sessions/session-b",
      expect.objectContaining({
        args: expect.arrayContaining(["--remote-debugging-port=9223"]),
      }),
    );
  });

  it("attaches to an existing CDP endpoint without launching a context", async () => {
    const persistedPage = {
      close: vi.fn(async () => undefined),
      goto: vi.fn(async () => undefined),
      url: vi.fn(() => "https://example.com/existing"),
    };
    const context = createBrowserContextMock();
    context.pages.mockReturnValue([persistedPage as never]);
    const browser = {
      close: vi.fn(async () => undefined),
      contexts: vi.fn(() => [context]),
      on: vi.fn(),
    };
    connectOverCDP.mockResolvedValue(browser);
    const service = new BrowserService({
      headless: true,
      profileDir: "/tmp/browser-profiles",
    });

    const session = await service.createSession(
      "session-attached",
      "https://example.com",
      {
        type: "connect-cdp",
        endpoint: "http://127.0.0.1:9333",
      },
    );

    expect(connectOverCDP).toHaveBeenCalledWith("http://127.0.0.1:9333");
    expect(launchPersistentContext).not.toHaveBeenCalled();
    expect(session.page).toBe(persistedPage);
    expect(service.getRemoteDebuggingPort("session-attached")).toBe(9333);
  });

  it("disconnects from an attached CDP browser without closing the page", async () => {
    const page = {
      close: vi.fn(async () => undefined),
      goto: vi.fn(async () => undefined),
      url: vi.fn(() => "https://example.com/existing"),
    };
    const context = createBrowserContextMock();
    context.pages.mockReturnValue([page as never]);
    const browser = {
      close: vi.fn(async () => undefined),
      contexts: vi.fn(() => [context]),
      on: vi.fn(),
    };
    connectOverCDP.mockResolvedValue(browser);
    const service = new BrowserService({
      headless: true,
      profileDir: "/tmp/browser-profiles",
    });

    const session = await service.createSession(
      "session-attached",
      "https://example.com",
      {
        type: "connect-cdp",
        endpoint: "http://127.0.0.1:9333",
      },
    );
    await service.destroySession("session-attached", session);

    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(page.close).not.toHaveBeenCalled();
    expect(context.close).not.toHaveBeenCalled();
  });

  it("restores sessions from an existing persisted page without navigating again", async () => {
    const persistedPage = {
      close: vi.fn(async () => undefined),
      goto: vi.fn(async () => undefined),
      url: vi.fn(() => "https://example.com"),
    };
    const context = createBrowserContextMock();
    context.pages.mockReturnValue([persistedPage as never]);
    launchPersistentContext.mockResolvedValue(context);
    const service = new BrowserService({
      headless: true,
      profileDir: "/tmp/browser-profiles",
    });

    const session = await service.restoreSession(
      "session-restored",
      "https://example.com",
      {
        type: "launch",
        profilePath: "/tmp/browser-profiles/sessions/session-restored",
        proxyEnabled: false,
        headers: {},
      },
    );

    expect(session.page).toBe(persistedPage);
    expect(context.newPage).not.toHaveBeenCalled();
    expect(persistedPage.goto).not.toHaveBeenCalled();
  });

  it("ignores the default blank page when restoring a session", async () => {
    const blankPage = {
      close: vi.fn(async () => undefined),
      goto: vi.fn(async () => undefined),
      url: vi.fn(() => "about:blank"),
    };
    const persistedPage = {
      close: vi.fn(async () => undefined),
      goto: vi.fn(async () => undefined),
      url: vi.fn(() => "https://example.com"),
    };
    const context = createBrowserContextMock();
    context.pages.mockReturnValue([blankPage as never, persistedPage as never]);
    launchPersistentContext.mockResolvedValue(context);
    const service = new BrowserService({
      headless: true,
      profileDir: "/tmp/browser-profiles",
    });

    const session = await service.restoreSession(
      "session-restored",
      "https://example.com",
      {
        type: "launch",
        profilePath: "/tmp/browser-profiles/sessions/session-restored",
        proxyEnabled: false,
        headers: {},
      },
    );

    expect(session.page).toBe(persistedPage);
    expect(context.newPage).not.toHaveBeenCalled();
  });
});
