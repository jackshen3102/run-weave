import { configurationLibrary as config } from "../lib/configuration.mjs";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

export function sessionConfiguration(sessionId, paths) {
  const context = config.resolveConfigurationContext({ args: ["--instance", sessionId, "--config-dir", paths.sessionDir] });
  return { context, store: new config.ConfigurationStore(context), args: config.configurationArguments(context) };
}

export function initializeSessionConfiguration(sessionId, paths) {
  const { context, store } = sessionConfiguration(sessionId, paths);
  if (existsSync(store.file)) {
    // The Backend cannot become ready with an invalid core domain. Surface its
    // configuration error before launching the installed App and health timer.
    const snapshot = store.read();
    for (const domain of config.BACKEND_CORE_CONFIGURATION_DOMAINS) {
      if (snapshot.issues[domain]?.length) {
        throw new config.ConfigurationError("CONFIG_DOMAIN_INVALID", snapshot.issues[domain].map((issue) => issue.path));
      }
    }
    for (const key of ["username", "password", "jwtSecret"]) {
      if (!snapshot.value.backend?.auth?.[key]?.trim()) {
        throw new config.ConfigurationError("CONFIG_AUTH_MIGRATION_REQUIRED", [`backend.auth.${key}`]);
      }
    }
    return;
  }
  const value = config.emptyConfiguration(context);
  const fields = {
    "backend.auth.username": `dev-${sessionId}`,
    "backend.auth.password": randomBytes(32).toString("base64url"),
    "backend.auth.jwtSecret": randomBytes(32).toString("base64url"),
    "backend.server.strictPort": true,
    "storage.browserProfileDirectory": path.join(paths.sessionDir, "browser-profile"),
    "storage.activityDirectory": path.join(paths.sessionDir, "data", "activity"),
    "storage.evolutionDirectory": path.join(paths.sessionDir, "data", "evolution"),
    "storage.experienceDirectory": path.join(paths.sessionDir, "data", "experience"),
    "storage.scheduledTasksDirectory": path.join(paths.sessionDir, "data", "scheduled-tasks"),
    "appServer.stateDirectory": path.join(paths.sessionDir, "app-server"),
    "appServer.cloudSyncDirectory": path.join(paths.sessionDir, "app-server", "cloud-sync"),
    "appServer.discovery": "auto",
    "logging.backendDirectory": path.join(paths.sessionDir, "logs", "backend"),
    "desktop.preferences.companion.enabled": false,
  };
  for (const [key, entry] of Object.entries(fields)) config.setConfigurationValue(value, key, entry);
  store.initialize(value);
}
