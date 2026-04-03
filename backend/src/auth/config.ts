import crypto from "node:crypto";

interface AuthConfig {
  username: string;
  password: string;
  jwtSecret: string;
  tokenTtlMs: number;
}

function parseTokenTtlMs(rawTtl: string | undefined): number {
  if (!rawTtl) {
    return 8 * 60 * 60 * 1000;
  }

  const ttlSeconds = Number(rawTtl);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error(
      "[viewer-be] AUTH_TOKEN_TTL_SECONDS must be a positive number",
    );
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
    tokenTtlMs: parseTokenTtlMs(process.env.AUTH_TOKEN_TTL_SECONDS),
  };
}

export type { AuthConfig };
