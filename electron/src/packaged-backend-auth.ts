import { app, net } from "electron";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { resolveBrowserProfileDir } from "@runweave/shared/browser-profile-node";
import { isBetaChannel, isDev } from "./desktop-config.js";

interface PackagedBackendAuthConfig {
  username: string;
  password: string;
  jwtSecret: string;
  createdAt: string;
}

interface BetaPersistedAuthRecord {
  username: string;
  password: string;
  jwtSecret: string;
  updatedAt: string;
  refreshSessions?: unknown[];
}

interface BetaAuthStoreData {
  auth: BetaPersistedAuthRecord | null;
}

interface BetaCliAuthResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

const PACKAGED_BACKEND_AUTH_FILE_NAME = "backend-auth.json";
const BETA_AUTH_USERNAME = "admin";
const BETA_AUTH_PASSWORD = "admin";

export function resolvePackagedBackendProfileDir(): string {
  return resolveBrowserProfileDir(process.env, os.homedir(), "/");
}

export function resolvePackagedBackendAuthFile(): string {
  return path.join(app.getPath("userData"), PACKAGED_BACKEND_AUTH_FILE_NAME);
}

export function resolveBetaAuthStoreFile(): string {
  return path.join(resolvePackagedBackendProfileDir(), "auth-store.json");
}

export function createRandomCredential(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function isPackagedBackendAuthConfig(
  value: unknown,
): value is PackagedBackendAuthConfig {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.username === "string" &&
    record.username.trim().length > 0 &&
    typeof record.password === "string" &&
    record.password.trim().length > 0 &&
    typeof record.jwtSecret === "string" &&
    record.jwtSecret.trim().length > 0 &&
    typeof record.createdAt === "string" &&
    record.createdAt.trim().length > 0
  );
}

export function writePackagedBackendAuthConfig(
  filePath: string,
  config: PackagedBackendAuthConfig,
): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best-effort permission tightening; non-fatal on filesystems that
    // do not support POSIX modes.
  }
}

export function loadOrCreatePackagedBackendAuthConfig(): PackagedBackendAuthConfig {
  const filePath = resolvePackagedBackendAuthFile();
  if (existsSync(filePath)) {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!isPackagedBackendAuthConfig(parsed)) {
      throw new Error(
        `[electron] invalid packaged backend auth file: ${filePath}`,
      );
    }
    return parsed;
  }

  const config: PackagedBackendAuthConfig = {
    username: `runweave-${createRandomCredential(9)}`,
    password: createRandomCredential(),
    jwtSecret: createRandomCredential(),
    createdAt: new Date().toISOString(),
  };
  writePackagedBackendAuthConfig(filePath, config);
  return config;
}

export function isBetaPersistedAuthRecord(
  value: unknown,
): value is BetaPersistedAuthRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.username === "string" &&
    record.username.trim().length > 0 &&
    typeof record.password === "string" &&
    record.password.trim().length > 0 &&
    typeof record.jwtSecret === "string" &&
    record.jwtSecret.trim().length > 0 &&
    typeof record.updatedAt === "string" &&
    record.updatedAt.trim().length > 0
  );
}

export function readBetaAuthStore(): {
  data: BetaAuthStoreData;
  record: BetaPersistedAuthRecord;
} | null {
  const filePath = resolveBetaAuthStoreFile();
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const data = JSON.parse(
      readFileSync(filePath, "utf8"),
    ) as BetaAuthStoreData;
    if (!isBetaPersistedAuthRecord(data.auth)) {
      return null;
    }
    return {
      data,
      record: {
        ...data.auth,
        refreshSessions: Array.isArray(data.auth.refreshSessions)
          ? data.auth.refreshSessions
          : [],
      },
    };
  } catch {
    return null;
  }
}

export function toPackagedBackendAuthConfig(
  record: BetaPersistedAuthRecord,
): PackagedBackendAuthConfig {
  return {
    username: record.username,
    password: record.password,
    jwtSecret: record.jwtSecret,
    createdAt: record.updatedAt,
  };
}

export function writeMigratedBetaAuthStore(
  data: BetaAuthStoreData,
  record: BetaPersistedAuthRecord,
  bootstrap: PackagedBackendAuthConfig,
): void {
  const filePath = resolveBetaAuthStoreFile();
  const tempPath = `${filePath}.tmp`;
  writeFileSync(
    tempPath,
    `${JSON.stringify(
      {
        ...data,
        auth: {
          ...record,
          username: bootstrap.username,
          password: bootstrap.password,
          jwtSecret: bootstrap.jwtSecret,
          updatedAt: new Date().toISOString(),
          refreshSessions: [],
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  chmodSync(tempPath, 0o600);
  renameSync(tempPath, filePath);
}

export function resolveBetaPackagedBackendAuthConfig(): PackagedBackendAuthConfig {
  const persisted = readBetaAuthStore();
  if (!persisted) {
    return {
      ...loadOrCreatePackagedBackendAuthConfig(),
      username: BETA_AUTH_USERNAME,
      password: BETA_AUTH_PASSWORD,
    };
  }

  const config = {
    ...toPackagedBackendAuthConfig(persisted.record),
    username: BETA_AUTH_USERNAME,
    password: BETA_AUTH_PASSWORD,
  };
  if (
    persisted.record.username !== BETA_AUTH_USERNAME ||
    persisted.record.password !== BETA_AUTH_PASSWORD
  ) {
    writeMigratedBetaAuthStore(persisted.data, persisted.record, config);
  }
  return config;
}

export function readBetaCliRefreshToken(): string | null {
  const configPath = process.env.RUNWEAVE_CONFIG_FILE;
  if (!configPath || !existsSync(configPath)) {
    return null;
  }
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      profiles?: { beta?: { refreshToken?: unknown } };
    };
    const refreshToken = config.profiles?.beta?.refreshToken;
    return typeof refreshToken === "string" && refreshToken.trim()
      ? refreshToken
      : null;
  } catch {
    return null;
  }
}

export async function requestBetaCliAuth(
  baseUrl: string,
  authConfig: PackagedBackendAuthConfig,
): Promise<BetaCliAuthResponse> {
  const refreshToken = readBetaCliRefreshToken();
  if (refreshToken) {
    const refreshResponse = await net.fetch(`${baseUrl}/api/auth/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-auth-client": "electron",
      },
      body: JSON.stringify({ refreshToken }),
    });
    if (refreshResponse.ok) {
      return (await refreshResponse.json()) as BetaCliAuthResponse;
    }
  }

  const loginResponse = await net.fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-auth-client": "electron",
    },
    body: JSON.stringify({
      username: authConfig.username,
      password: authConfig.password,
    }),
  });
  if (!loginResponse.ok) {
    throw new Error(
      `Beta CLI login failed with status ${loginResponse.status}`,
    );
  }
  return (await loginResponse.json()) as BetaCliAuthResponse;
}

export async function ensureBetaCliProfile(baseUrl: string): Promise<void> {
  if (!isBetaChannel) {
    return;
  }
  const configPath = process.env.RUNWEAVE_CONFIG_FILE;
  if (!configPath) {
    throw new Error("Beta CLI config path is unavailable");
  }
  const auth = await requestBetaCliAuth(
    baseUrl,
    resolveBetaPackagedBackendAuthConfig(),
  );
  if (!auth.accessToken || !auth.refreshToken || !auth.expiresIn) {
    throw new Error("Beta CLI login returned an incomplete auth response");
  }
  mkdirSync(path.dirname(configPath), { recursive: true });
  const tempConfigPath = `${configPath}.tmp`;
  writeFileSync(
    tempConfigPath,
    `${JSON.stringify(
      {
        activeProfile: "beta",
        profiles: {
          beta: {
            baseUrl,
            accessToken: auth.accessToken,
            refreshToken: auth.refreshToken,
            expiresAt: new Date(
              Date.now() + auth.expiresIn * 1000,
            ).toISOString(),
          },
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  chmodSync(tempConfigPath, 0o600);
  renameSync(tempConfigPath, configPath);
  rmSync(resolvePackagedBackendAuthFile(), { force: true });
}

export function hasCompleteAuthEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.AUTH_USERNAME?.trim() &&
    env.AUTH_PASSWORD?.trim() &&
    env.AUTH_JWT_SECRET?.trim(),
  );
}

export function resolvePackagedBackendAuthEnv(
  env: NodeJS.ProcessEnv,
): Pick<
  NodeJS.ProcessEnv,
  "AUTH_USERNAME" | "AUTH_PASSWORD" | "AUTH_JWT_SECRET"
> {
  if (!isBetaChannel && hasCompleteAuthEnv(env)) {
    return {
      AUTH_USERNAME: env.AUTH_USERNAME,
      AUTH_PASSWORD: env.AUTH_PASSWORD,
      AUTH_JWT_SECRET: env.AUTH_JWT_SECRET,
    };
  }

  const config = isBetaChannel
    ? resolveBetaPackagedBackendAuthConfig()
    : loadOrCreatePackagedBackendAuthConfig();
  return {
    AUTH_USERNAME: config.username,
    AUTH_PASSWORD: config.password,
    AUTH_JWT_SECRET: config.jwtSecret,
  };
}

export function buildPackagedBackendBaseEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(!isDev ? resolvePackagedBackendAuthEnv(process.env) : {}),
    BROWSER_PROFILE_DIR: resolvePackagedBackendProfileDir(),
  };
}
