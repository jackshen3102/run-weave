import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EnvironmentContext } from "@runweave/shared/configuration";
import { ConfigurationError } from "./errors";
import { readPrivateFile } from "./private-file";
import { emptyConfiguration, setConfigurationValue } from "./store";
import { discoverMigrationSources, type SelectedMigrationPaths } from "./migration-discovery";

export function assertNewStableInstallation(context: EnvironmentContext, selected: SelectedMigrationPaths = {}): void {
  if (context.kind !== "stable") throw new ConfigurationError("CONFIG_STABLE_REQUIRED");
  if (existsSync(path.join(context.configRoot, "settings.yaml"))) throw new ConfigurationError("CONFIG_ALREADY_EXISTS");
  const legacy = discoverMigrationSources(context, selected);
  if (legacy.length) throw new ConfigurationError("CONFIG_MIGRATION_REQUIRED", legacy.map((source) => source.domain));
  // Historic Stable backend profiles may live outside the Desktop userData and
  // were previously selected from a project-dependent browser-profile root.
  for (const root of [path.join(context.configRoot, "browser-profile"), path.join(os.userInfo().homedir, ".browser-profile")]) {
    if (!existsSync(root)) continue;
    const children = lstatSync(root).isDirectory() ? [root, ...readdirSync(root).map((name) => path.join(root, name))] : [root];
    for (const directory of children) {
      if (["auth-store.json", "session-store.json", "terminal-session-store.json"].some((name) => existsSync(path.join(directory, name)))) {
        throw new ConfigurationError("CONFIG_MIGRATION_REQUIRED", ["backend.profile"]);
      }
    }
  }
}

export function readInitialAuthFile(file: string): { username: string; password: string } {
  if (!path.isAbsolute(file)) throw new ConfigurationError("CONFIG_AUTH_FILE_ABSOLUTE_REQUIRED");
  let value: unknown;
  try { value = JSON.parse(readPrivateFile(file, 4096)); }
  catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError("CONFIG_INITIAL_AUTH_INVALID");
  }
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some((key) => !["username", "password"].includes(key)) ||
    typeof (value as Record<string, unknown>).username !== "string" ||
    typeof (value as Record<string, unknown>).password !== "string") {
    throw new ConfigurationError("CONFIG_INITIAL_AUTH_INVALID");
  }
  return value as { username: string; password: string };
}

export function prepareInitialConfiguration(
  context: EnvironmentContext,
  auth: { username: string; password: string },
) {
  if (!auth.username?.trim() || !auth.password || auth.password.length < 16) {
    throw new ConfigurationError("CONFIG_INITIAL_AUTH_INVALID", ["backend.auth"]);
  }
  if (auth.username === "admin" && auth.password === "admin") {
    throw new ConfigurationError("CONFIG_INITIAL_AUTH_INVALID", ["backend.auth"]);
  }
  const value = emptyConfiguration(context);
  const data = path.join(context.configRoot, "data");
  const profile = path.join(data, "backend");
  const fields = {
    "backend.auth.username": auth.username.trim(),
    "backend.auth.password": auth.password,
    "backend.auth.jwtSecret": randomBytes(32).toString("base64url"),
    "backend.server.strictPort": true,
    "storage.browserProfileDirectory": profile,
    "storage.authStoreFile": path.join(profile, "auth-store.json"),
    "storage.terminalSessionStoreFile": path.join(profile, "terminal-session-store.json"),
    "storage.terminalQuickInputStoreFile": path.join(profile, "terminal-quick-inputs.json"),
    "storage.scheduledTasksDirectory": path.join(profile, "scheduled-tasks"),
    "storage.activityDirectory": path.join(data, "activity"),
    "storage.evolutionDirectory": path.join(data, "evolution"),
    "storage.experienceDirectory": path.join(data, "experience"),
    "storage.feishuDirectory": path.join(data, "feishu"),
    "logging.backendDirectory": path.join(context.configRoot, "logs", "backend"),
    "appServer.stateDirectory": path.join(data, "app-server"),
    "appServer.cloudSyncDirectory": path.join(data, "app-server", "cloud-sync"),
    "appServer.discovery": "auto",
    "desktop.preferences.companion.enabled": false,
  } as const;
  for (const [key, entry] of Object.entries(fields)) setConfigurationValue(value, key, entry);
  return value;
}
