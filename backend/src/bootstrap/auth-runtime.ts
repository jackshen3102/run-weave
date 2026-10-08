import { ConnectionIdentityService } from "../auth/connection-identity";
import { LowDbAuthStore } from "../auth/lowdb-store";
import { loadAuthConfig } from "../auth/config";
import { AuthService } from "../auth/service";
import type { StoragePaths } from "../utils/path";
import type { ResourceScope } from "./resource-scope";

export async function createAuthRuntime(storagePaths: StoragePaths, resources: ResourceScope) {
  const connectionIdentity = await ConnectionIdentityService.load(storagePaths.browserProfileDir);
  const authConfig = loadAuthConfig();
  const authStore = new LowDbAuthStore(storagePaths.authStoreFile);
  resources.defer("auth-store", () => authStore.dispose());
  const persistedAuth = await authStore.initialize({
    username: authConfig.username,
    password: authConfig.password,
    jwtSecret: authConfig.jwtSecret,
    updatedAt: new Date().toISOString(),
    refreshSessions: [],
  });
  const authService = new AuthService(
    {
      ...authConfig,
      username: persistedAuth.username,
      password: persistedAuth.password,
      jwtSecret: persistedAuth.jwtSecret,
      initialRefreshSessions: persistedAuth.refreshSessions,
    },
    authStore,
  );
  return { connectionIdentity, authConfig, authStore, authService };
}
