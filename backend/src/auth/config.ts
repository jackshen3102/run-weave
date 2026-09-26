import { settingText, configuration } from "@runweave/config-node";

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

function requireStrictAuthValue(
  value: string | undefined,
  envName: string,
): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`[viewer-be] missing required configuration field: ${envName}`);
  }
  return normalized;
}

function rejectUnsafeStrictAuthDefaults(
  username: string,
  password: string,
  jwtSecret: string,
): void {
  if (
    username === "admin" &&
    password === "admin" &&
    configuration().context.kind === "stable"
  ) {
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
  const username = settingText("backend.auth.username")?.trim();
  const password = settingText("backend.auth.password")?.trim();
  const jwtSecret = settingText("backend.auth.jwtSecret")?.trim();
  configuration().requireDomain("backend.auth");
  const resolvedUsername = requireStrictAuthValue(username, "backend.auth.username");
  const resolvedPassword = requireStrictAuthValue(password, "backend.auth.password");
  const resolvedJwtSecret = requireStrictAuthValue(jwtSecret, "backend.auth.jwtSecret");
  rejectUnsafeStrictAuthDefaults(resolvedUsername, resolvedPassword, resolvedJwtSecret);

  return {
    username: resolvedUsername,
    password: resolvedPassword,
    jwtSecret: resolvedJwtSecret,
    accessTokenTtlMs: parsePositiveMs(
      settingText("backend.auth.accessTokenTtlSeconds"),
      24 * 60 * 60 * 1000,
      settingText("backend.auth.accessTokenTtlSeconds") != null
        ? "AUTH_ACCESS_TOKEN_TTL_SECONDS"
        : "AUTH_TOKEN_TTL_SECONDS",
    ),
    refreshTokenTtlMs: parsePositiveMs(
      settingText("backend.auth.refreshTokenTtlSeconds"),
      30 * 24 * 60 * 60 * 1000,
      "AUTH_REFRESH_TOKEN_TTL_SECONDS",
    ),
    refreshCookieName:
      settingText("backend.auth.refreshCookieName")?.trim() || "viewer_refresh",
    secureCookies:
      settingText("backend.auth.secureCookies")?.trim().toLowerCase() !== "false",
  };
}

export type { AuthConfig };
