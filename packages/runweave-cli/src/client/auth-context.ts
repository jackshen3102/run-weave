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
  deferRefresh?: boolean;
}): Promise<AuthContext> {
  const store = params.store ?? new ProfileStore();
  const resolved = await store.resolve(params.profileName, params.env, {
    backendPort: params.backendPort,
  });
  let current = resolved.profile;

  if (
    !params.deferRefresh &&
    !resolved.usesEnvAccessToken &&
    (!current.accessToken || isExpired(current))
  ) {
    current = await refreshStoredProfile(store, resolved, current);
  }

  if (!current.accessToken && !params.deferRefresh) {
    throw new HttpError(401, "Runweave access token is missing");
  }

  const state: AuthState = { current };

  return {
    profileName: resolved.name,
    baseUrl: current.baseUrl,
    accessToken: current.accessToken ?? "",
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
      params.resolved.usesEnvAccessToken
    ) {
      throw error;
    }
  }

  if (params.state.current.accessToken === requestedProfile.accessToken) {
    params.state.refreshPromise ??= (async () => {
      const refreshed = await refreshStoredProfile(
        params.store,
        params.resolved,
        params.state.current,
        params.init?.signal ?? undefined,
      );
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

async function refreshStoredProfile(
  store: ProfileStore,
  resolved: ResolvedProfile,
  previous: RunweaveProfile,
  signal?: AbortSignal,
): Promise<RunweaveProfile> {
  return store.updateProfile(
    resolved.name,
    async (saved) => {
      // Never copy credentials from a different backend into a long-lived client.
      if (saved && saved.baseUrl !== previous.baseUrl) {
        throw new HttpError(
          401,
          "Runweave profile backend changed; restart the client",
        );
      }
      if (!saved)
        throw new HttpError(
          401,
          "Runweave profile was removed; login required",
        );
      const latest = saved;
      if (
        latest.accessToken &&
        latest.accessToken !== previous.accessToken &&
        !isExpired(latest)
      ) {
        return latest;
      }
      if (!latest.refreshToken)
        throw new HttpError(401, "Runweave login required");
      return createAuthClient().refresh(
        latest,
        signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
      );
    },
    signal,
  );
}
