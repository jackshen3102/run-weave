import {
  type ResolvedProfile,
  type RunweaveProfile,
  ProfileStore,
} from "../config/profile-store.js";
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

interface AuthState {
  current: RunweaveProfile;
  refreshPromise?: Promise<RunweaveProfile>;
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

  const state: AuthState = { current };

  return {
    profileName: resolved.name,
    baseUrl: current.baseUrl,
    accessToken: current.accessToken,
    async requestJson<T>(apiPath: string, init?: RequestInit) {
      return requestWithAuth<T>({
        resolved,
        state,
        store,
        apiPath,
        init,
        parse: "json",
      });
    },
    async requestVoid(apiPath: string, init?: RequestInit) {
      await requestWithAuth<void>({
        resolved,
        state,
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
  state: AuthState;
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

  const requestedProfile = params.state.current;
  try {
    return await requestWithParser<T>(
      requestedProfile.baseUrl,
      params.apiPath,
      makeInit(requestedProfile.accessToken ?? ""),
      params.parse,
    );
  } catch (error) {
    if (
      !(error instanceof HttpError) ||
      error.status !== 401 ||
      params.resolved.usesEnvAccessToken ||
      !requestedProfile.refreshToken
    ) {
      throw error;
    }
  }

  if (params.state.current.accessToken === requestedProfile.accessToken) {
    params.state.refreshPromise ??= (async () => {
      const refreshed = await createAuthClient().refresh(params.state.current);
      await params.store.saveProfile(params.resolved.name, refreshed);
      params.state.current = refreshed;
      return refreshed;
    })().finally(() => {
      params.state.refreshPromise = undefined;
    });
    await params.state.refreshPromise;
  }

  const current = params.state.current;
  return requestWithParser<T>(
    current.baseUrl,
    params.apiPath,
    makeInit(current.accessToken ?? ""),
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
