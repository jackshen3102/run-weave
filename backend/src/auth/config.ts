interface AuthConfig {
  username: string;
  password: string;
  jwtSecret: string;
  tokenTtlMs: number;
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `[viewer-be] missing required environment variable: ${name}`,
    );
  }
  return value;
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
  return {
    username: readRequiredEnv("AUTH_USERNAME"),
    password: readRequiredEnv("AUTH_PASSWORD"),
    jwtSecret: readRequiredEnv("AUTH_JWT_SECRET"),
    tokenTtlMs: parseTokenTtlMs(process.env.AUTH_TOKEN_TTL_SECONDS),
  };
}

export type { AuthConfig };
