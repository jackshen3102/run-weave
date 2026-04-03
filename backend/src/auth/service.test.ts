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

  it("changes password only when old password matches", async () => {
    const service = new AuthService({
      username: "admin",
      password: "secret",
      jwtSecret: "jwt-secret",
      tokenTtlMs: 60_000,
    });

    await expect(
      service.changePassword("wrong", "new-secret"),
    ).resolves.toBe(false);

    expect(service.login("admin", "secret")).toBeTruthy();
    expect(service.login("admin", "new-secret")).toBeNull();
  });

  it("invalidates existing tokens after password change", async () => {
    const service = new AuthService({
      username: "admin",
      password: "secret",
      jwtSecret: "jwt-secret",
      tokenTtlMs: 60_000,
    });

    const issued = service.login("admin", "secret");
    expect(issued).toBeTruthy();

    await expect(
      service.changePassword("secret", "new-secret"),
    ).resolves.toBe(true);

    expect(service.verifyToken(issued!.token)).toBe(false);
    expect(service.login("admin", "secret")).toBeNull();
    expect(service.login("admin", "new-secret")).toBeTruthy();
  });
});
