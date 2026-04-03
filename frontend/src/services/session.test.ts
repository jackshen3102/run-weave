import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDevtoolsTicket,
  createSession,
  deleteSession,
  getDefaultCdpEndpoint,
  listSessions,
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
});
