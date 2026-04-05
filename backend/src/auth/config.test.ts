import { afterEach, describe, expect, it } from "vitest";
import { loadAuthConfig } from "./config";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("loadAuthConfig", () => {
  it("loads username and password from env with default ttls", () => {
    process.env.AUTH_USERNAME = "e2e-admin";
    process.env.AUTH_PASSWORD = "e2e-secret";
    process.env.AUTH_JWT_SECRET = "jwt-secret";
    delete process.env.AUTH_ACCESS_TOKEN_TTL_SECONDS;
    delete process.env.AUTH_REFRESH_TOKEN_TTL_SECONDS;

    const config = loadAuthConfig();
    expect(config.username).toBe("e2e-admin");
    expect(config.password).toBe("e2e-secret");
    expect(config.jwtSecret).toBe("jwt-secret");
    expect(config.accessTokenTtlMs).toBe(15 * 60 * 1000);
    expect(config.refreshTokenTtlMs).toBe(30 * 24 * 60 * 60 * 1000);
    expect(config.refreshCookieName).toBe("viewer_refresh");
    expect(config.secureCookies).toBe(true);
  });

  it("parses access and refresh ttl seconds", () => {
    delete process.env.AUTH_USERNAME;
    delete process.env.AUTH_PASSWORD;
    process.env.AUTH_JWT_SECRET = "jwt-secret";
    process.env.AUTH_ACCESS_TOKEN_TTL_SECONDS = "300";
    process.env.AUTH_REFRESH_TOKEN_TTL_SECONDS = "600";

    const config = loadAuthConfig();
    expect(config.accessTokenTtlMs).toBe(300_000);
    expect(config.refreshTokenTtlMs).toBe(600_000);
  });

  it("throws for invalid access ttl", () => {
    process.env.AUTH_JWT_SECRET = "jwt-secret";
    process.env.AUTH_ACCESS_TOKEN_TTL_SECONDS = "0";

    expect(() => loadAuthConfig()).toThrow(
      "AUTH_ACCESS_TOKEN_TTL_SECONDS must be a positive number",
    );
  });

  it("generates a jwt secret when none is provided", () => {
    delete process.env.AUTH_JWT_SECRET;
    delete process.env.AUTH_ACCESS_TOKEN_TTL_SECONDS;
    delete process.env.AUTH_REFRESH_TOKEN_TTL_SECONDS;

    const config = loadAuthConfig();

    expect(config.username).toBe("admin");
    expect(config.password).toBe("admin");
    expect(config.jwtSecret.length).toBeGreaterThan(10);
  });

  it("falls back to default credentials when env vars are missing", () => {
    delete process.env.AUTH_USERNAME;
    delete process.env.AUTH_PASSWORD;
    process.env.AUTH_JWT_SECRET = "jwt-secret";

    const config = loadAuthConfig();

    expect(config.username).toBe("admin");
    expect(config.password).toBe("admin");
  });
});
