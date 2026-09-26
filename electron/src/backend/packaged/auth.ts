import { net } from "electron";
import {
  configuration, configurationPath, settingText, ConfigurationError,
} from "@runweave/config-node";
import type { LoginResponse } from "@runweave/shared/protocol";
import { localBackendAuthHeaders } from "../health-auth.js";

export function resolvePackagedBackendProfileDir(): string {
  return configurationPath("storage.browserProfileDirectory", "backend");
}

export function readPackagedBackendCredentials(): { username: string; password: string; jwtSecret: string } {
  configuration().requireDomain("backend.auth");
  const username = settingText("backend.auth.username");
  const password = settingText("backend.auth.password");
  const jwtSecret = settingText("backend.auth.jwtSecret");
  if (!username || !password || !jwtSecret) throw new ConfigurationError("CONFIG_AUTH_MIGRATION_REQUIRED");
  return { username, password, jwtSecret };
}

export async function requestBetaDevSessionAuth(baseUrl: string, backendPid?: number): Promise<LoginResponse> {
  const runtime = configuration();
  if (runtime.context.kind !== "dev") throw new ConfigurationError("CONFIG_DEV_INSTANCE_REQUIRED");
  const profile = resolvePackagedBackendProfileDir();
  const health = await net.fetch(`${baseUrl}/health`, {
    redirect: "error",
    headers: localBackendAuthHeaders(`${baseUrl}/health`, profile, undefined, backendPid),
  });
  const payload = await health.json() as { environment?: { kind?: string; instanceId?: string; configRoot?: string } };
  if (!health.ok || payload.environment?.kind !== "dev" || payload.environment.instanceId !== runtime.context.instanceId || payload.environment.configRoot !== runtime.context.configRoot) throw new ConfigurationError("CONFIG_TARGET_MISMATCH");
  const credentials = readPackagedBackendCredentials();
  const endpoint = `${baseUrl}/api/auth/login`;
  const response = await net.fetch(endpoint, {
    method: "POST", redirect: "error",
    headers: {
      ...localBackendAuthHeaders(endpoint, profile, undefined, backendPid),
      "Content-Type": "application/json", "x-auth-client": "electron",
    },
    body: JSON.stringify({ username: credentials.username, password: credentials.password }),
  });
  if (!response.ok) throw new ConfigurationError("CONFIG_DEV_LOGIN_FAILED");
  const session = await response.json() as LoginResponse;
  if (!session.accessToken || !session.refreshToken || !session.sessionId || !session.expiresIn) throw new ConfigurationError("CONFIG_DEV_LOGIN_INCOMPLETE");
  return session;
}

// Kept while the installed-session control plane still calls its historic name.
export async function ensureBetaCliProfile(baseUrl: string): Promise<void> {
  const runtime = configuration();
  if (runtime.context.kind !== "dev") return;
  const auth = await requestBetaDevSessionAuth(baseUrl);
  const current = runtime.store.read();
  runtime.store.patch({ expectedRevision: current.value.revision, expectedDigest: current.digest, changes: {
    "cli.activeProfile": "dev",
    "cli.profiles.dev": { baseUrl, accessToken: auth.accessToken, refreshToken: auth.refreshToken!,
      expiresAt: new Date(Date.now() + auth.expiresIn * 1000).toISOString() },
  } });
}

export function buildPackagedBackendBaseEnv(): NodeJS.ProcessEnv {
  readPackagedBackendCredentials();
  return { ...process.env };
}
