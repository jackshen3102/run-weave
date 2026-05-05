import { type ResolvedProfile, ProfileStore } from "../config/profile-store.js";
import { HttpError } from "../errors.js";
import { createAuthClient, isExpired } from "./auth-client.js";
import { requestJson } from "./http.js";

export interface AuthContext {
  profileName: string;
  baseUrl: string;
  accessToken: string;
  requestJson<T>(apiPath: string, init?: RequestInit): Promise<T>;
}

export async function resolveAuthContext(params: {
  profileName?: string;
  store?: ProfileStore;
  env?: NodeJS.ProcessEnv;
}): Promise<AuthContext> {
  const store = params.store ?? new ProfileStore();
  const resolved = await store.resolve(params.profileName, params.env);
  const authClient = createAuthClient();
  let current = resolved.profile;

  if (!current.accessToken || (!resolved.usesEnvAccessToken && isExpired(current))) {
    current = await authClient.refresh(current);
    if (!resolved.usesEnvAccessToken) {
      await store.saveProfile(resolved.name, current);
    }
  }

  if (!current.accessToken) {
    throw new HttpError(401, "Runweave access token is missing");
  }

  return {
    profileName: resolved.name,
    baseUrl: current.baseUrl,
    accessToken: current.accessToken,
    async requestJson<T>(apiPath: string, init?: RequestInit) {
      return requestWithAuth<T>({
        resolved,
        current,
        store,
        apiPath,
        init,
      });
    },
  };
}

async function requestWithAuth<T>(params: {
  resolved: ResolvedProfile;
  current: { baseUrl: string; accessToken?: string; refreshToken?: string; expiresAt?: string };
  store: ProfileStore;
  apiPath: string;
  init?: RequestInit;
}): Promise<T> {
  const makeInit = (accessToken: string): RequestInit => ({
    ...params.init,
    headers: {
      ...params.init?.headers,
      Authorization: `Bearer ${accessToken}`,
    },
  });

  try {
    return await requestJson<T>(
      params.current.baseUrl,
      params.apiPath,
      makeInit(params.current.accessToken ?? ""),
    );
  } catch (error) {
    if (
      !(error instanceof HttpError) ||
      error.status !== 401 ||
      params.resolved.usesEnvAccessToken ||
      !params.current.refreshToken
    ) {
      throw error;
    }
  }

  const refreshed = await createAuthClient().refresh(params.current);
  await params.store.saveProfile(params.resolved.name, refreshed);
  return requestJson<T>(
    refreshed.baseUrl,
    params.apiPath,
    makeInit(refreshed.accessToken ?? ""),
  );
}
