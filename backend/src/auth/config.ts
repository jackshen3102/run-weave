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

function parsePositiveMs(
  rawTtl: string | undefined,
  fallbackMs: number,
  envName: string,
): number {
  if (!rawTtl) {
    return fallbackMs;
  }

  const ttlSeconds = Number(rawTtl);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error(`[viewer-be] ${envName} must be a positive number`);
  }

  return ttlSeconds * 1000;
}

function isStrictAuthConfigRequired(): boolean {
  return (
    process.env.NODE_ENV === "production" ||
    process.env.ELECTRON_RUN_AS_NODE === "1" ||
    Boolean(process.env.RUNWEAVE_RUNTIME_RELEASE_ID?.trim())
  );
}

function requireStrictAuthValue(
  value: string | undefined,
  envName: string,
): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`[viewer-be] missing required auth env: ${envName}`);
  }
  return normalized;
}

function rejectUnsafeStrictAuthDefaults(
  username: string,
  password: string,
  jwtSecret: string,
): void {
  if (username === "admin" && password === "admin") {
    throw new Error("[viewer-be] refusing default admin/admin credentials");
  }
  if (
    jwtSecret === "runweave-local-jwt-secret" ||
    jwtSecret === "browser-viewer-local-jwt-secret"
  ) {
    throw new Error("[viewer-be] refusing default packaged JWT secret");
  }
}

export function loadAuthConfig(): AuthConfig {
  const username = process.env.AUTH_USERNAME?.trim();
  const password = process.env.AUTH_PASSWORD?.trim();
  const jwtSecret = process.env.AUTH_JWT_SECRET?.trim();
  const strictAuthConfigRequired = isStrictAuthConfigRequired();
  const resolvedUsername = strictAuthConfigRequired
    ? requireStrictAuthValue(username, "AUTH_USERNAME")
    : username || "admin";
  const resolvedPassword = strictAuthConfigRequired
    ? requireStrictAuthValue(password, "AUTH_PASSWORD")
    : password || "admin";
  const resolvedJwtSecret = strictAuthConfigRequired
    ? requireStrictAuthValue(jwtSecret, "AUTH_JWT_SECRET")
    : jwtSecret || crypto.randomBytes(32).toString("base64url");

  if (strictAuthConfigRequired) {
    rejectUnsafeStrictAuthDefaults(
      resolvedUsername,
      resolvedPassword,
      resolvedJwtSecret,
    );
  }

  return {
    username: resolvedUsername,
    password: resolvedPassword,
    jwtSecret: resolvedJwtSecret,
    accessTokenTtlMs: parsePositiveMs(
      process.env.AUTH_ACCESS_TOKEN_TTL_SECONDS ??
        process.env.AUTH_TOKEN_TTL_SECONDS,
      24 * 60 * 60 * 1000,
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
