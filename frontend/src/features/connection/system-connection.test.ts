import { describe, expect, it } from "vitest";
import {
  buildLocalDevelopmentConnection,
  resolveNeedsConnection,
  shouldExposeLocalDevelopmentConnection,
  shouldShowReconnectAction,
} from "./system-connection";

describe("buildLocalDevelopmentConnection", () => {
  it("keeps the system local connection visible even when unavailable", () => {
    expect(
      buildLocalDevelopmentConnection({
        kind: "packaged-local",
        available: false,
        backendUrl: "",
        statusMessage: "内置本地后端不可用",
        canReconnect: true,
      }),
    ).toEqual({
      id: "system:local-development",
      name: "本地开发",
      url: "",
      createdAt: 0,
      isSystem: true,
      canEdit: false,
      canDelete: false,
      available: false,
      statusMessage: "内置本地后端不可用",
      canReconnect: true,
    });
  });
});

describe("shouldExposeLocalDevelopmentConnection", () => {
  it("hides the system local connection in electron dev mode when no packaged backend is managed", () => {
    expect(shouldExposeLocalDevelopmentConnection(true, false)).toBe(false);
  });

  it("shows the system local connection only when electron manages a packaged backend", () => {
    expect(shouldExposeLocalDevelopmentConnection(true, true)).toBe(true);
  });
});

describe("resolveNeedsConnection", () => {
  it("requires selecting a connection when the active electron system backend is unavailable", () => {
    expect(
      resolveNeedsConnection(true, {
        id: "system:local-development",
        name: "本地开发",
        url: "",
        createdAt: 0,
        available: false,
      }),
    ).toBe(true);
  });

  it("keeps non-electron web mode independent from connection selection", () => {
    expect(
      resolveNeedsConnection(false, {
        id: "remote-1",
        name: "Remote",
        url: "https://example.com",
        createdAt: 1,
      }),
    ).toBe(false);
  });
});

describe("shouldShowReconnectAction", () => {
  it("hides reconnect for healthy connections even when reconnect is supported", () => {
    expect(
      shouldShowReconnectAction({
        id: "system:local-development",
        name: "本地开发",
        url: "http://127.0.0.1:5001",
        createdAt: 0,
        available: true,
        canReconnect: true,
      }),
    ).toBe(false);
  });

  it("shows reconnect only for unavailable reconnectable connections", () => {
    expect(
      shouldShowReconnectAction({
        id: "system:local-development",
        name: "本地开发",
        url: "",
        createdAt: 0,
        available: false,
        canReconnect: true,
      }),
    ).toBe(true);
  });
});
