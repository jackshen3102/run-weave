import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession } from "./session";

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
        url: "https://example.com",
        source: { type: "launch", proxyEnabled: true },
      },
      "token-1",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/session",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          url: "https://example.com",
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
        url: "https://example.com",
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
          url: "https://example.com",
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
        url: "https://example.com",
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
          url: "https://example.com",
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
});
