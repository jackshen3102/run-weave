import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import type { Request, Response } from "express";
import {
  createTunnelAuthMiddleware,
  createTunnelTokenBootstrapMiddleware,
  isTunnelRequestAuthorized,
  loadTunnelAuthConfig,
  shouldRequireTunnelAuth,
  type TunnelAuthConfig,
} from "./tunnel-auth";

const config: TunnelAuthConfig = {
  token: "secret-token",
  cookieName: "runweave_tunnel",
  scope: "forwarded",
};

function createRequest(
  url: string,
  options?: {
    headers?: Record<string, string>;
    remoteAddress?: string;
    secure?: boolean;
  },
): Request {
  return {
    url,
    headers: options?.headers ?? {},
    socket: {
      remoteAddress: options?.remoteAddress ?? "127.0.0.1",
    },
    secure: options?.secure ?? false,
  } as unknown as Request;
}

function createResponse(): Response & {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
} {
  const response = {
    status: vi.fn(() => response),
    json: vi.fn(() => response),
    setHeader: vi.fn(() => response),
  } as unknown as Response & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
    setHeader: ReturnType<typeof vi.fn>;
  };
  return response;
}

describe("tunnel auth", () => {
  it("loads config only when a tunnel token is configured", () => {
    expect(loadTunnelAuthConfig({})).toBeNull();
    expect(
      loadTunnelAuthConfig({
        RUNWEAVE_TUNNEL_TOKEN: " token-1 ",
        RUNWEAVE_TUNNEL_COOKIE_NAME: " tunnel ",
        RUNWEAVE_TUNNEL_AUTH_SCOPE: "all",
      }),
    ).toEqual({
      token: "token-1",
      cookieName: "tunnel",
      scope: "all",
    });
  });

  it("does not require tunnel auth for direct loopback requests by default", () => {
    const request = createRequest(
      "/api/terminal/session",
    ) as unknown as IncomingMessage;
    expect(shouldRequireTunnelAuth(request, config)).toBe(false);
  });

  it("requires tunnel auth for forwarded requests", () => {
    const request = createRequest("/api/terminal/session", {
      headers: { "x-forwarded-for": "203.0.113.10" },
    }) as unknown as IncomingMessage;
    expect(shouldRequireTunnelAuth(request, config)).toBe(true);
  });

  it("rejects forwarded HTTP requests without a tunnel token", () => {
    const middleware = createTunnelAuthMiddleware(config);
    const request = createRequest("/api/terminal/session", {
      headers: { "cf-connecting-ip": "203.0.113.10" },
    });
    const response = createResponse();
    const next = vi.fn();

    middleware(request, response, next);

    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith({
      message: "Tunnel token required",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("accepts forwarded HTTP requests with a valid cookie token", () => {
    const middleware = createTunnelAuthMiddleware(config);
    const request = createRequest("/api/terminal/session", {
      headers: {
        "cf-connecting-ip": "203.0.113.10",
        cookie: "runweave_tunnel=secret-token",
      },
    });
    const response = createResponse();
    const next = vi.fn();

    middleware(request, response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.status).not.toHaveBeenCalled();
  });

  it("bootstraps a tunnel cookie from a query token without rejecting static requests", () => {
    const middleware = createTunnelTokenBootstrapMiddleware(config);
    const request = createRequest("/?token=secret-token", {
      headers: {
        "x-forwarded-proto": "https",
      },
      secure: true,
    });
    const response = createResponse();
    const next = vi.fn();

    middleware(request, response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.setHeader).toHaveBeenCalledWith(
      "Set-Cookie",
      "runweave_tunnel=secret-token; Path=/; HttpOnly; SameSite=Lax; Secure",
    );
    expect(response.status).not.toHaveBeenCalled();
  });

  it("keeps websocket app token separate from tunnel token", () => {
    const missingTunnelToken = createRequest("/ws?token=viewer-ticket", {
      headers: { "x-forwarded-for": "203.0.113.10" },
    }) as unknown as IncomingMessage;
    const withTunnelToken = createRequest(
      "/ws?token=viewer-ticket&tunnelToken=secret-token",
      {
        headers: { "x-forwarded-for": "203.0.113.10" },
      },
    ) as unknown as IncomingMessage;

    expect(isTunnelRequestAuthorized(missingTunnelToken, config)).toBe(false);
    expect(isTunnelRequestAuthorized(withTunnelToken, config)).toBe(true);
  });
});
