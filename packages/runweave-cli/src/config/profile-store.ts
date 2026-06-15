import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CliError } from "../errors.js";

export interface RunweaveProfile {
  baseUrl: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
}

export interface RunweaveConfig {
  activeProfile: string;
  profiles: Record<string, RunweaveProfile>;
}

export interface ResolvedProfile {
  name: string;
  profile: RunweaveProfile;
  usesEnvAccessToken: boolean;
}

const DEFAULT_PROFILE = "local";
const DEFAULT_BACKEND_PORT = "5001";

export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.RUNWEAVE_CONFIG_FILE?.trim() ||
    path.join(os.homedir(), ".runweave", "config.json")
  );
}

export class ProfileStore {
  readonly filePath: string;

  constructor(filePath = resolveConfigPath()) {
    this.filePath = filePath;
  }

  async load(): Promise<RunweaveConfig | null> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as RunweaveConfig;
      return {
        activeProfile: parsed.activeProfile || DEFAULT_PROFILE,
        profiles: parsed.profiles ?? {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async save(config: RunweaveConfig): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await writeFile(this.filePath, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(this.filePath, 0o600);
  }

  async saveProfile(name: string, profile: RunweaveProfile): Promise<void> {
    const current = (await this.load()) ?? {
      activeProfile: name,
      profiles: {},
    };
    current.activeProfile = name;
    current.profiles[name] = profile;
    await this.save(current);
  }

  async resolve(
    profileName?: string,
    env: NodeJS.ProcessEnv = process.env,
    options?: { backendPort?: string },
  ): Promise<ResolvedProfile> {
    const config = await this.load();
    const name = profileName || config?.activeProfile || DEFAULT_PROFILE;
    const saved = config?.profiles[name];
    const baseUrl = resolveRunweaveBaseUrl({
      env,
      explicitBackendPort: options?.backendPort,
      configuredBaseUrl: saved?.baseUrl,
    });
    const envAccessToken = env.RUNWEAVE_ACCESS_TOKEN?.trim();

    if (envAccessToken) {
      return {
        name,
        profile: {
          ...saved,
          baseUrl,
          accessToken: envAccessToken,
        },
        usesEnvAccessToken: true,
      };
    }

    if (!saved?.accessToken && !saved?.refreshToken) {
      throw new CliError(
        `Runweave profile "${name}" is not logged in. Run rw auth login first.`,
        3,
      );
    }

    return {
      name,
      profile: {
        ...saved,
        baseUrl,
      },
      usesEnvAccessToken: false,
    };
  }
}

export async function assertOwnerOnlyReadable(filePath: string): Promise<void> {
  await access(filePath, constants.R_OK);
  await chmod(filePath, 0o600);
}

export function normalizeBaseUrl(value: string | undefined): string {
  const baseUrl = value?.trim() || `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`;
  return baseUrl.replace(/\/+$/, "");
}

export function resolveRunweaveBaseUrl(params: {
  env?: NodeJS.ProcessEnv;
  explicitBaseUrl?: string;
  explicitBackendPort?: string;
  configuredBaseUrl?: string;
}): string {
  const env = params.env ?? process.env;
  const explicitBaseUrl = params.explicitBaseUrl?.trim();
  if (explicitBaseUrl) {
    return normalizeBaseUrl(explicitBaseUrl);
  }

  const explicitBackendPort = params.explicitBackendPort?.trim();
  if (explicitBackendPort) {
    return `http://127.0.0.1:${normalizeBackendPort(explicitBackendPort)}`;
  }

  const envBaseUrl = env.RUNWEAVE_BASE_URL?.trim();
  if (envBaseUrl) {
    return normalizeBaseUrl(envBaseUrl);
  }

  const backendPort = env.RUNWEAVE_BACKEND_PORT?.trim();
  if (backendPort) {
    return `http://127.0.0.1:${normalizeBackendPort(backendPort)}`;
  }

  return normalizeBaseUrl(params.configuredBaseUrl);
}

function normalizeBackendPort(value: string): string {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliError(
      "RUNWEAVE_BACKEND_PORT must be an integer from 1 to 65535",
      2,
    );
  }
  return String(port);
}

export function calculateExpiresAt(expiresInSeconds: number): string {
  return new Date(Date.now() + expiresInSeconds * 1000).toISOString();
}
