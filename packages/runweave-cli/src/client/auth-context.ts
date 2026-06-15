import { type ResolvedProfile, ProfileStore } from "../config/profile-store.js";
import { HttpError } from "../errors.js";
import { createAuthClient, isExpired } from "./auth-client.js";
import { requestJson, requestVoid } from "./http.js";

export interface AuthContext {
  profileName: string;
  baseUrl: string;
  accessToken: string;
  requestJson<T>(apiPath: string, init?: RequestInit): Promise<T>;
  requestVoid(apiPath: string, init?: RequestInit): Promise<void>;
}

export async function resolveAuthContext(params: {
  profileName?: string;
  backendPort?: string;
  store?: ProfileStore;
  env?: NodeJS.ProcessEnv;
}): Promise<AuthContext> {
  const store = params.store ?? new ProfileStore();
  const resolved = await store.resolve(params.profileName, params.env, {
    backendPort: params.backendPort,
  });
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
        parse: "json",
      });
    },
    async requestVoid(apiPath: string, init?: RequestInit) {
      await requestWithAuth<void>({
        resolved,
        current,
        store,
        apiPath,
        init,
        parse: "void",
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
  parse: "json" | "void";
}): Promise<T> {
  const makeInit = (accessToken: string): RequestInit => ({
    ...params.init,
    headers: {
      ...params.init?.headers,
      Authorization: `Bearer ${accessToken}`,
    },
  });

  try {
    return await requestWithParser<T>(
      params.current.baseUrl,
      params.apiPath,
      makeInit(params.current.accessToken ?? ""),
      params.parse,
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
  return requestWithParser<T>(
    refreshed.baseUrl,
    params.apiPath,
    makeInit(refreshed.accessToken ?? ""),
    params.parse,
  );
}

async function requestWithParser<T>(
  baseUrl: string,
  apiPath: string,
  init: RequestInit,
  parse: "json" | "void",
): Promise<T> {
  if (parse === "void") {
    await requestVoid(baseUrl, apiPath, init);
    return undefined as T;
  }
  return requestJson<T>(baseUrl, apiPath, init);
}
