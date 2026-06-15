import {
  ProfileStore,
  resolveRunweaveBaseUrl,
  resolveConfigPath,
  type RunweaveProfile,
} from "../config/profile-store.js";

const DEFAULT_PROFILE = "local";

export interface CliBaseUrlContext {
  profileName: string;
  baseUrl: string;
  accessToken?: string;
  profile?: RunweaveProfile;
  accessTokenSource: "env" | "profile" | "none";
}

export async function resolveCliBaseUrl(params: {
  profileName?: string;
  backendPort?: string;
  env?: NodeJS.ProcessEnv;
  store?: ProfileStore;
}): Promise<CliBaseUrlContext> {
  const env = params.env ?? process.env;
  const store = params.store ?? new ProfileStore(resolveConfigPath(env));
  const config = await store.load();
  const profileName =
    params.profileName ?? config?.activeProfile ?? DEFAULT_PROFILE;
  const profile = config?.profiles[profileName];
  const baseUrl = resolveRunweaveBaseUrl({
    env,
    explicitBackendPort: params.backendPort,
    configuredBaseUrl: profile?.baseUrl,
  });
  const envAccessToken = env.RUNWEAVE_ACCESS_TOKEN?.trim();

  if (envAccessToken) {
    return {
      profileName,
      baseUrl,
      accessToken: envAccessToken,
      profile,
      accessTokenSource: "env",
    };
  }

  return {
    profileName,
    baseUrl,
    accessToken: profile?.accessToken,
    profile,
    accessTokenSource: profile?.accessToken ? "profile" : "none",
  };
}
