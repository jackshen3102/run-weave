import { describe, expect, it, vi } from "vitest";
import { issueToken, verifyToken } from "./jwt";

describe("jwt helpers", () => {
  it("issues a typed token and verifies it", () => {
    const token = issueToken({
      username: "admin",
      sessionId: "auth-session-1",
      secret: "secret-key",
      ttlMs: 60_000,
      tokenType: "access",
    });

    expect(token.expiresIn).toBe(60);
    const verified = verifyToken(token.token, "secret-key");
    expect(verified).toEqual({
      valid: true,
      payload: {
        sub: "admin",
        sid: "auth-session-1",
        exp: expect.any(Number),
        type: "access",
        resource: undefined,
      },
    });
  });

  it("rejects malformed token", () => {
    expect(verifyToken("bad-token", "secret-key")).toEqual({ valid: false });
  });

  it("rejects expired token", () => {
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValueOnce(1_000_000);
    const token = issueToken({
      username: "admin",
      sessionId: "auth-session-1",
      secret: "secret-key",
      ttlMs: 1_000,
      tokenType: "refresh",
    });
    nowSpy.mockReturnValue(1_100_000);

    expect(verifyToken(token.token, "secret-key")).toEqual({ valid: false });
    nowSpy.mockRestore();
  });
});
