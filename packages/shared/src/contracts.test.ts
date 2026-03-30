import { describe, expect, it } from "vitest";
import type { CreateSessionRequest } from "./protocol";

describe("shared contracts", () => {
  it("keeps create session request shape stable", () => {
    const request: CreateSessionRequest = {
      url: "https://example.com",
      source: {
        type: "launch",
        proxyEnabled: false,
      },
    };

    expect(request.source).toBeDefined();
    if (!request.source) {
      throw new Error("Expected source to be defined");
    }

    expect(request.source.type).toBe("launch");
  });
});
