import { afterEach, describe, expect, it } from "vitest";
import { loadAuthConfig } from "./config";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("loadAuthConfig", () => {
  it("loads required auth env with default ttl", () => {
    process.env.AUTH_USERNAME = "admin";
    process.env.AUTH_PASSWORD = "secret";
    process.env.AUTH_JWT_SECRET = "jwt-secret";
    delete process.env.AUTH_TOKEN_TTL_SECONDS;

    const config = loadAuthConfig();
    expect(config.username).toBe("admin");
    expect(config.password).toBe("secret");
    expect(config.jwtSecret).toBe("jwt-secret");
    expect(config.tokenTtlMs).toBe(8 * 60 * 60 * 1000);
  });

  it("parses ttl seconds", () => {
    process.env.AUTH_USERNAME = "admin";
    process.env.AUTH_PASSWORD = "secret";
    process.env.AUTH_JWT_SECRET = "jwt-secret";
    process.env.AUTH_TOKEN_TTL_SECONDS = "300";

    const config = loadAuthConfig();
    expect(config.tokenTtlMs).toBe(300_000);
  });

  it("throws for invalid ttl", () => {
    process.env.AUTH_USERNAME = "admin";
    process.env.AUTH_PASSWORD = "secret";
    process.env.AUTH_JWT_SECRET = "jwt-secret";
    process.env.AUTH_TOKEN_TTL_SECONDS = "0";

    expect(() => loadAuthConfig()).toThrow(
      "AUTH_TOKEN_TTL_SECONDS must be a positive number",
    );
  });
});
