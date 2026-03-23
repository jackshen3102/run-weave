import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession } from "./session";

describe("session service", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends proxyEnabled when creating a session", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ sessionId: "s-1", viewerUrl: "/?sessionId=s-1" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await createSession(
      "",
      { url: "https://example.com", proxyEnabled: true },
      "token-1",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/session",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          url: "https://example.com",
          proxyEnabled: true,
        }),
      }),
    );
  });

  it("sends profilePath when creating a session with a custom profile", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ sessionId: "s-1", viewerUrl: "/?sessionId=s-1" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await createSession(
      "",
      {
        url: "https://example.com",
        proxyEnabled: false,
        profilePath: "/profiles/custom-profile",
      },
      "token-1",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/session",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          url: "https://example.com",
          proxyEnabled: false,
          profilePath: "/profiles/custom-profile",
        }),
      }),
    );
  });
});
