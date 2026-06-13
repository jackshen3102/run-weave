import { describe, expect, it } from "vitest";
import type { Request } from "express";
import {
  isLocalDirectRequest,
  isValidLocalCdpEndpoint,
} from "./local-cdp-endpoint";

function createRequest(options: {
  remoteAddress?: string;
  headers?: Record<string, string>;
}): Request {
  return {
    headers: options.headers ?? {},
    socket: {
      remoteAddress: options.remoteAddress,
    },
  } as unknown as Request;
}

describe("local CDP endpoint guards", () => {
  it("accepts direct loopback requests without forwarded headers", () => {
    expect(
      isLocalDirectRequest(createRequest({ remoteAddress: "127.0.0.1" })),
    ).toBe(true);
    expect(isLocalDirectRequest(createRequest({ remoteAddress: "::1" }))).toBe(
      true,
    );
  });

  it("rejects non-loopback or forwarded requests", () => {
    expect(
      isLocalDirectRequest(createRequest({ remoteAddress: "192.0.2.10" })),
    ).toBe(false);
    expect(
      isLocalDirectRequest(
        createRequest({
          remoteAddress: "127.0.0.1",
          headers: { "x-forwarded-for": "203.0.113.10" },
        }),
      ),
    ).toBe(false);
  });

  it("accepts only plain local HTTP CDP endpoints with explicit ports", () => {
    expect(isValidLocalCdpEndpoint("http://127.0.0.1:9222/")).toBe(true);
    expect(isValidLocalCdpEndpoint("http://localhost:9222/")).toBe(true);
    expect(isValidLocalCdpEndpoint("http://[::1]:9222/")).toBe(true);

    expect(isValidLocalCdpEndpoint("https://127.0.0.1:9222/")).toBe(false);
    expect(isValidLocalCdpEndpoint("http://127.0.0.1/")).toBe(false);
    expect(isValidLocalCdpEndpoint("http://127.0.0.1:9222/json")).toBe(false);
    expect(isValidLocalCdpEndpoint("http://127.0.0.1:9222/?q=1")).toBe(false);
    expect(isValidLocalCdpEndpoint("http://user@127.0.0.1:9222/")).toBe(false);
    expect(isValidLocalCdpEndpoint("http://example.com:9222/")).toBe(false);
    expect(isValidLocalCdpEndpoint("not a url")).toBe(false);
  });
});
