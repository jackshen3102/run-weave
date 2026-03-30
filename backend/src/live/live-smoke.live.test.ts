import { describe, expect, it } from "vitest";

describe("live smoke", () => {
  it("validates live env configuration when enabled", () => {
    const enabled = process.env.LIVE_SMOKE_ENABLED === "true";
    if (!enabled) {
      expect(true).toBe(true);
      return;
    }

    const targetUrl = process.env.LIVE_TARGET_URL;
    const authToken = process.env.LIVE_AUTH_TOKEN;

    expect(targetUrl).toBeTruthy();
    expect(authToken).toBeTruthy();
    expect(() => new URL(targetUrl as string)).not.toThrow();
  });
});
