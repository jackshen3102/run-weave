import { describe, expect, it } from "vitest";
import { AuthService } from "./service";

describe("AuthService", () => {
  it("returns token for valid credentials", () => {
    const service = new AuthService({
      username: "admin",
      password: "secret",
      jwtSecret: "jwt-secret",
      tokenTtlMs: 60_000,
    });

    const result = service.login("admin", "secret");
    expect(result).toBeTruthy();
    expect(typeof result?.token).toBe("string");
  });

  it("rejects invalid credentials", () => {
    const service = new AuthService({
      username: "admin",
      password: "secret",
      jwtSecret: "jwt-secret",
      tokenTtlMs: 60_000,
    });

    expect(service.login("admin", "wrong")).toBeNull();
  });

  it("verifies issued token", () => {
    const service = new AuthService({
      username: "admin",
      password: "secret",
      jwtSecret: "jwt-secret",
      tokenTtlMs: 60_000,
    });

    const result = service.login("admin", "secret");
    expect(result).toBeTruthy();
    expect(service.verifyToken(result!.token)).toBe(true);
    expect(service.verifyToken("bad-token")).toBe(false);
  });
});
