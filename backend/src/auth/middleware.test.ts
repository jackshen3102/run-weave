import { describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import { createRequireAuth, readBearerToken } from "./middleware";

describe("auth middleware", () => {
  it("extracts bearer token", () => {
    const request = {
      headers: { authorization: "Bearer token-123" },
    } as unknown as Request;

    expect(readBearerToken(request)).toBe("token-123");
  });

  it("returns null when authorization header is missing", () => {
    const request = { headers: {} } as unknown as Request;
    expect(readBearerToken(request)).toBeNull();
  });

  it("rejects unauthorized request", () => {
    const authService = { verifyAccessToken: vi.fn(() => null) };
    const middleware = createRequireAuth(authService as never);
    const req = {
      headers: { authorization: "Bearer bad" },
    } as unknown as Request;
    const res = {
      status: vi.fn(() => res),
      json: vi.fn(() => res),
    };
    const next = vi.fn();

    middleware(req, res as never, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("passes authorized request", () => {
    const authService = {
      verifyAccessToken: vi.fn(() => ({
        sessionId: "session-1",
        username: "admin",
      })),
    };
    const middleware = createRequireAuth(authService as never);
    const req = {
      headers: { authorization: "Bearer good" },
    } as unknown as Request;
    const res = {
      status: vi.fn(() => res),
      json: vi.fn(() => res),
    };
    const next = vi.fn();

    middleware(req, res as never, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
