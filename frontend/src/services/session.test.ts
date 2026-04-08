import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureAiDefaultSession,
  getAiDefaultSession,
  createAiBridge,
  createDevtoolsTicket,
  createSession,
  deleteSession,
  getDefaultCdpEndpoint,
  getSessionTabFavicon,
  listSessions,
  revokeAiBridge,
  updateSessionAiPreference,
  updateSession,
} from "./session";

describe("session service", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends launch source settings when creating a session", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ sessionId: "s-1", viewerUrl: "/?sessionId=s-1" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await createSession(
      "",
      {
        name: "Default Playweight",
        preferredForAi: true,
        source: { type: "launch", proxyEnabled: true },
      },
      "token-1",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/session",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "Default Playweight",
          preferredForAi: true,
          source: {
            type: "launch",
            proxyEnabled: true,
          },
        }),
      }),
    );
  });

  it("sends a CDP endpoint when attaching to an existing browser", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ sessionId: "s-1", viewerUrl: "/?sessionId=s-1" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await createSession(
      "",
      {
        name: "CDP Playweight",
        source: {
          type: "connect-cdp",
          endpoint: "http://127.0.0.1:9333",
        },
      },
      "token-1",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/session",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "CDP Playweight",
          source: {
            type: "connect-cdp",
            endpoint: "http://127.0.0.1:9333",
          },
        }),
      }),
    );
  });

  it("sends per-session headers when provided", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ sessionId: "s-1", viewerUrl: "/?sessionId=s-1" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await createSession(
      "",
      {
        name: "Default Playweight",
        source: {
          type: "launch",
          proxyEnabled: false,
          headers: {
            authorization: "Bearer demo",
            "x-session-id": "s-1",
          },
        },
      },
      "token-1",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/session",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "Default Playweight",
          source: {
            type: "launch",
            proxyEnabled: false,
            headers: {
              authorization: "Bearer demo",
              "x-session-id": "s-1",
            },
          },
        }),
      }),
    );
  });

  it("sends a browser profile when launching a new browser", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ sessionId: "s-1", viewerUrl: "/?sessionId=s-1" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await createSession(
      "",
      {
        name: "Default Playweight",
        source: {
          type: "launch",
          proxyEnabled: false,
          browserProfile: {
            locale: "en-US",
            timezoneId: "Asia/Shanghai",
            userAgent: "Playwright Stable Test Agent",
            viewport: {
              width: 1440,
              height: 900,
            },
          },
        },
      },
      "token-1",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/session",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "Default Playweight",
          source: {
            type: "launch",
            proxyEnabled: false,
            browserProfile: {
              locale: "en-US",
              timezoneId: "Asia/Shanghai",
              userAgent: "Playwright Stable Test Agent",
              viewport: {
                width: 1440,
                height: 900,
              },
            },
          },
        }),
      }),
    );
  });

  it("lists sessions with the bearer token", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await listSessions("http://localhost:5001", "token-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5001/api/session",
      {
        headers: {
          Authorization: "Bearer token-1",
        },
      },
    );
  });

  it("loads a tab favicon with the bearer token", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob(["icon"], { type: "image/png" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await getSessionTabFavicon(
      "http://localhost:5001",
      "token-1",
      "session/1",
      "tab/1",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5001/api/session/session%2F1/tabs/tab%2F1/favicon",
      {
        headers: {
          Authorization: "Bearer token-1",
        },
        signal: undefined,
      },
    );
  });

  it("reads the default cdp endpoint with the bearer token", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ endpoint: "http://127.0.0.1:9222" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await getDefaultCdpEndpoint("http://localhost:5001", "token-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5001/api/session/cdp-endpoint-default",
      {
        headers: {
          Authorization: "Bearer token-1",
        },
      },
    );
  });

  it("reads the preferred ai session with the bearer token", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        sessionId: "s-1",
        connected: false,
        name: "AI Viewer",
        preferredForAi: true,
        proxyEnabled: false,
        sourceType: "launch",
        headers: {},
        createdAt: "2026-04-08T00:00:00.000Z",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await getAiDefaultSession("http://localhost:5001", "token-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5001/api/session/ai-default",
      {
        headers: {
          Authorization: "Bearer token-1",
        },
      },
    );
  });

  it("ensures the preferred ai session with the bearer token", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        sessionId: "s-1",
        connected: false,
        name: "AI Viewer",
        preferredForAi: true,
        proxyEnabled: false,
        sourceType: "launch",
        headers: {},
        createdAt: "2026-04-08T00:00:00.000Z",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await ensureAiDefaultSession("http://localhost:5001", "token-1", "AI Viewer");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5001/api/session/ai-default/ensure",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer token-1",
        },
        body: JSON.stringify({
          name: "AI Viewer",
        }),
      },
    );
  });

  it("deletes a session by encoded id", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await deleteSession("http://localhost:5001", "token-1", "session/1");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5001/api/session/session%2F1",
      {
        method: "DELETE",
        headers: {
          Authorization: "Bearer token-1",
        },
      },
    );
  });

  it("updates a session name by encoded id", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        sessionId: "session/1",
        connected: false,
        tabs: [],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await updateSession(
      "http://localhost:5001",
      "token-1",
      "session/1",
      {
        name: "Renamed session",
      },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5001/api/session/session%2F1",
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer token-1",
        },
        body: JSON.stringify({
          name: "Renamed session",
        }),
      },
    );
  });

  it("updates ai preference by encoded id", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        sessionId: "session/1",
        connected: false,
        preferredForAi: true,
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await updateSessionAiPreference(
      "http://localhost:5001",
      "token-1",
      "session/1",
      true,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5001/api/session/session%2F1/ai-preference",
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer token-1",
        },
        body: JSON.stringify({
          preferredForAi: true,
        }),
      },
    );
  });

  it("creates a devtools ticket for the encoded session id", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ticket: "ticket-1",
        expiresIn: 60,
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await createDevtoolsTicket(
      "http://localhost:5001",
      "token-1",
      "session/1",
      {
        tabId: "tab-1",
      },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5001/api/session/session%2F1/devtools-ticket",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer token-1",
        },
        body: JSON.stringify({
          tabId: "tab-1",
        }),
      },
    );
  });

  it("creates and revokes an ai bridge for the encoded session id", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => ({
        ok: true,
        json: async () => ({
          bridgeUrl: "ws://127.0.0.1:5001/ws/ai-bridge?sessionId=session%2F1",
        }),
      }))
      .mockImplementationOnce(async () => ({
        ok: true,
        json: async () => ({}),
      }));
    vi.stubGlobal("fetch", fetchMock);

    await createAiBridge(
      "http://localhost:5001",
      "token-1",
      "session/1",
      {
        tabId: "tab-1",
      },
    );
    await revokeAiBridge(
      "http://localhost:5001",
      "token-1",
      "session/1",
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://localhost:5001/api/session/session%2F1/ai-bridge",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer token-1",
        },
        body: JSON.stringify({
          tabId: "tab-1",
        }),
      },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://localhost:5001/api/session/session%2F1/ai-bridge",
      {
        method: "DELETE",
        headers: {
          Authorization: "Bearer token-1",
        },
      },
    );
  });
});
