import crypto from "node:crypto";

interface AuthConfig {
  username: string;
  password: string;
  jwtSecret: string;
  accessTokenTtlMs: number;
  refreshTokenTtlMs: number;
  refreshCookieName: string;
  secureCookies: boolean;
}

function parsePositiveMs(rawTtl: string | undefined, fallbackMs: number, envName: string): number {
  if (!rawTtl) {
    return fallbackMs;
  }

  const ttlSeconds = Number(rawTtl);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error(`[viewer-be] ${envName} must be a positive number`);
  }

  return ttlSeconds * 1000;
}

export function loadAuthConfig(): AuthConfig {
  const username = process.env.AUTH_USERNAME?.trim();
  const password = process.env.AUTH_PASSWORD?.trim();

  return {
    username: username || "admin",
    password: password || "admin",
    jwtSecret:
      process.env.AUTH_JWT_SECRET?.trim() ||
      crypto.randomBytes(32).toString("base64url"),
    accessTokenTtlMs: parsePositiveMs(
      process.env.AUTH_ACCESS_TOKEN_TTL_SECONDS ??
        process.env.AUTH_TOKEN_TTL_SECONDS,
      15 * 60 * 1000,
      process.env.AUTH_ACCESS_TOKEN_TTL_SECONDS != null
        ? "AUTH_ACCESS_TOKEN_TTL_SECONDS"
        : "AUTH_TOKEN_TTL_SECONDS",
    ),
    refreshTokenTtlMs: parsePositiveMs(
      process.env.AUTH_REFRESH_TOKEN_TTL_SECONDS,
      30 * 24 * 60 * 60 * 1000,
      "AUTH_REFRESH_TOKEN_TTL_SECONDS",
    ),
    refreshCookieName:
      process.env.AUTH_REFRESH_COOKIE_NAME?.trim() || "viewer_refresh",
    secureCookies:
      process.env.AUTH_COOKIE_SECURE?.trim().toLowerCase() !== "false",
  };
}

export type { AuthConfig };
