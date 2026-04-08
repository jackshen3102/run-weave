import { describe, expect, it } from "vitest";
import type { CreateSessionRequest } from "./protocol";

describe("shared contracts", () => {
  it("keeps create session request shape stable", () => {
    const request: CreateSessionRequest = {
      url: "https://example.com",
      source: {
        type: "launch",
        proxyEnabled: false,
        browserProfile: {
          locale: "en-US",
          timezoneId: "Asia/Shanghai",
          viewport: {
            width: 1440,
            height: 900,
          },
        },
      },
    };

    const { source } = request;
    expect(source).toBeDefined();
    if (!source) {
      throw new Error("Expected source to be defined");
    }

    expect(source.type).toBe("launch");
    if (source.type !== "launch") {
      throw new Error("Expected a launch session source");
    }

    expect(source.browserProfile?.viewport?.width).toBe(1440);
  });
});
