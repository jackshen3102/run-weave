import { describe, expect, it } from "vitest";
import {
  buildDevtoolsPageUrl,
  buildViewerWsUrl,
  getTabIdFromSearch,
  normalizeNavigationUrl,
  syncUrlTabId,
  toHttpBase,
  toWebSocketBase,
} from "./url";

describe("viewer url helpers", () => {
  it("converts api base to websocket base", () => {
    expect(toWebSocketBase("http://localhost:5000")).toBe(
      "ws://localhost:5000",
    );
    expect(toWebSocketBase("https://example.com")).toBe("wss://example.com");
    expect(toWebSocketBase("ws://already")).toBe("ws://already");
  });

  it("converts websocket base to http base", () => {
    expect(toHttpBase("ws://localhost:5000")).toBe("http://localhost:5000");
    expect(toHttpBase("wss://example.com")).toBe("https://example.com");
    expect(toHttpBase("https://already")).toBe("https://already");
  });

  it("builds websocket url with encoded params", () => {
    expect(buildViewerWsUrl("http://localhost:5000", "abc", "x y")).toBe(
      "ws://localhost:5000/ws?sessionId=abc&token=x%20y",
    );
  });

  it("builds devtools page url against backend base", () => {
    expect(buildDevtoolsPageUrl("", "session-1", "tab-1", "ticket-1")).toContain(
      "/devtools?sessionId=session-1&tabId=tab-1&ticket=ticket-1",
    );
  });

  it("normalizes navigation url", () => {
    expect(normalizeNavigationUrl("example.com")).toBe("https://example.com");
    expect(normalizeNavigationUrl(" http://example.com ")).toBe(
      "http://example.com",
    );
    expect(normalizeNavigationUrl("   ")).toBeNull();
  });

  it("extracts tab id from query string", () => {
    expect(getTabIdFromSearch("?sessionId=1&tabId=t-1")).toBe("t-1");
    expect(getTabIdFromSearch("?sessionId=1")).toBeNull();
  });

  it("syncs tab id to url query", () => {
    window.history.replaceState(null, "", "/viewer/s1");
    syncUrlTabId("tab-9");
    expect(window.location.pathname).toBe("/viewer/s1");
    expect(window.location.search).toContain("tabId=tab-9");

    syncUrlTabId(null);
    expect(window.location.pathname).toBe("/viewer/s1");
    expect(window.location.search).toBe("");
  });
});
