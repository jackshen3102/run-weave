import { beforeEach, describe, expect, it } from "vitest";
import {
  cleanupLegacyAuthStorage,
  clearConnectionToken,
  CONNECTION_AUTH_STORAGE_KEY,
  getConnectionAuth,
  REMEMBERED_CREDENTIALS_STORAGE_KEY,
  setConnectionToken,
} from "./storage";

describe("auth storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("cleans up legacy credentials and preserves only scoped tokens", () => {
    localStorage.setItem(
      REMEMBERED_CREDENTIALS_STORAGE_KEY,
      JSON.stringify({
        username: "legacy-admin",
        password: "legacy-secret",
      }),
    );
    localStorage.setItem(
      CONNECTION_AUTH_STORAGE_KEY,
      JSON.stringify({
        "conn-1": {
          token: "token-1",
          username: "legacy-admin",
          password: "legacy-secret",
        },
        "conn-2": {
          username: "missing-token",
        },
      }),
    );

    cleanupLegacyAuthStorage();

    expect(localStorage.getItem(REMEMBERED_CREDENTIALS_STORAGE_KEY)).toBeNull();
    expect(JSON.parse(localStorage.getItem(CONNECTION_AUTH_STORAGE_KEY) ?? "{}")).toEqual({
      "conn-1": {
        accessToken: "token-1",
        accessExpiresAt: expect.any(Number),
        sessionId: "legacy-session",
      },
    });
  });

  it("reads, writes, and clears a scoped connection token", () => {
    expect(getConnectionAuth("conn-1")).toBeNull();

    setConnectionToken("conn-1", "token-1");
    expect(getConnectionAuth("conn-1")).toEqual({
      accessToken: "token-1",
      accessExpiresAt: expect.any(Number),
      sessionId: "legacy-session",
    });

    clearConnectionToken("conn-1");
    expect(getConnectionAuth("conn-1")).toBeNull();
  });

  it("returns null for an empty connection id", () => {
    setConnectionToken("conn-1", "token-1");

    expect(getConnectionAuth(null)).toBeNull();
    expect(getConnectionAuth(undefined)).toBeNull();
    expect(getConnectionAuth("")).toBeNull();
  });
});
