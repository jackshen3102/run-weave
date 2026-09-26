import { settingText } from "@runweave/config-node";
import { acquireProcessLock } from "../runtime/process-lock.js";
import { constants } from "node:fs";
import { access, chmod } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ConfigurationStore, ConfigurationError, resolveConfigurationContext } from "@runweave/config-node";
import { configurationPathSegment, isConfigurationObject, type ConfigurationValue } from "@runweave/shared/configuration";
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

export function resolveConfigPath(): string {
  return path.join(resolveConfigurationContext().configRoot, "settings.yaml");
}

export class ProfileStore {
  readonly filePath: string;
  private readonly store: ConfigurationStore;
  private observed?: { revision: number; digest: string };

  constructor(filePath = resolveConfigPath()) {
    const context = resolveConfigurationContext();
    this.store = new ConfigurationStore(context);
    if (filePath !== this.store.file) throw new ConfigurationError("CONFIG_LEGACY_PATH_UNSUPPORTED");
    this.filePath = this.store.file;
  }

  async load(): Promise<RunweaveConfig | null> {
    const snapshot = this.store.read();
    if (snapshot.issues.cli?.length) throw new ConfigurationError("CONFIG_DOMAIN_INVALID", ["cli"]);
    this.observed = { revision: snapshot.value.revision, digest: snapshot.digest };
    const cli = snapshot.value.cli;
    if (!isConfigurationObject(cli)) return null;
    return { activeProfile: typeof cli.activeProfile === "string" ? cli.activeProfile : DEFAULT_PROFILE,
      profiles: (cli.profiles ?? {}) as unknown as Record<string, RunweaveProfile> };
  }

  async save(config: RunweaveConfig): Promise<void> {
    resolveConfigurationContext({ requireExplicit: true });
    if (!this.observed) throw new ConfigurationError("CONFIG_READ_BEFORE_WRITE_REQUIRED");
    const saved = this.store.patch({ expectedRevision: this.observed.revision, expectedDigest: this.observed.digest,
      changes: { cli: config as unknown as ConfigurationValue } });
    this.observed = { revision: saved.value.revision, digest: saved.digest };
  }

  async saveProfile(name: string, profile: RunweaveProfile): Promise<void> {
    await this.updateProfile(name, async () => profile, undefined, true);
  }

  async updateProfile(
    name: string,
    update: (profile: RunweaveProfile | undefined) => Promise<RunweaveProfile>,
    signal?: AbortSignal,
    activate = false,
  ): Promise<RunweaveProfile> {
    resolveConfigurationContext({ requireExplicit: true });
    if (!name || name.length > 512 || ["__proto__", "constructor", "prototype"].includes(name)) throw new ConfigurationError("CONFIG_PROFILE_NAME_INVALID");
    const lock = await acquireProcessLock(`${this.filePath}.cli-refresh`, 15_000, signal);
    try {
      const previous = (await this.load())?.profiles[name];
      const profile = await update(previous);
      for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        const current = this.store.read();
        const latest = (await this.load())?.profiles[name];
        if (JSON.stringify(latest) !== JSON.stringify(previous)) throw new ConfigurationError("CONFIG_PROFILE_CHANGED");
        try {
          this.store.patch({ expectedRevision: current.value.revision, expectedDigest: current.digest,
            changes: { [`cli.profiles.${configurationPathSegment(name)}`]: profile as unknown as ConfigurationValue,
              ...(activate ? { "cli.activeProfile": name } : {}) } });
          return profile;
        } catch (error) {
          if (!(error instanceof ConfigurationError) || !["CONFIG_WRITE_BUSY", "CONFIG_REVISION_CONFLICT"].includes(error.code) || attempt >= 20) throw error;
          await delay(50, undefined, { signal });
        }
      }
    } finally { await lock.release(); }
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
  const explicitBaseUrl = params.explicitBaseUrl?.trim();
  if (explicitBaseUrl) {
    return normalizeBaseUrl(explicitBaseUrl);
  }

  const explicitBackendPort = params.explicitBackendPort?.trim();
  if (explicitBackendPort) {
    return `http://127.0.0.1:${normalizeBackendPort(explicitBackendPort)}`;
  }

  if (params.configuredBaseUrl) return normalizeBaseUrl(params.configuredBaseUrl);

  const backendPort = settingText("backend.server.port")?.trim();
  if (backendPort) {
    return `http://127.0.0.1:${normalizeBackendPort(backendPort)}`;
  }

  return normalizeBaseUrl(params.configuredBaseUrl);
}

function normalizeBackendPort(value: string): string {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliError(
      "Backend port must be an integer from 1 to 65535",
      2,
    );
  }
  return String(port);
}

export function calculateExpiresAt(expiresInSeconds: number): string {
  return new Date(Date.now() + expiresInSeconds * 1000).toISOString();
}
