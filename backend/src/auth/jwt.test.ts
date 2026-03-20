import { describe, expect, it, vi } from "vitest";
import { issueToken, verifyToken } from "./jwt";

describe("jwt helpers", () => {
  it("issues token and verifies it", () => {
    const token = issueToken("admin", "secret-key", 60_000);

    expect(token.expiresIn).toBe(60);
    const verified = verifyToken(token.token, "secret-key");
    expect(verified).toEqual({ valid: true, username: "admin" });
  });

  it("rejects malformed token", () => {
    expect(verifyToken("bad-token", "secret-key")).toEqual({ valid: false });
  });

  it("rejects expired token", () => {
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValueOnce(1_000_000);
    const token = issueToken("admin", "secret-key", 1_000);
    nowSpy.mockReturnValue(1_100_000);

    expect(verifyToken(token.token, "secret-key")).toEqual({ valid: false });
    nowSpy.mockRestore();
  });
});
