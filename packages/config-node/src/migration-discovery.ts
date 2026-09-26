import { existsSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { readConfigurationPath, type EnvironmentContext } from "@runweave/shared/configuration";
import { assertOwnedPath, canonicalPath } from "./context";
import { ConfigurationError } from "./errors";
import type { MigrationDraft, MigrationSource } from "./migration";
import { setConfigurationValue } from "./store";

export interface SelectedMigrationPaths { backendProfile?: string; desktopData?: string }

/** Only the directories explicitly selected by the operator are inspected. */
export function discoverMigrationSources(context: EnvironmentContext, selected: SelectedMigrationPaths): MigrationSource[] {
  const sources: MigrationSource[] = [];
  const add = (root: string, relative: string, domain: string, format: "json" | "env" = "json") => {
    const file = path.join(root, relative);
    if (existsSync(file)) sources.push({ file, domain, format });
  };
  add(context.configRoot, "config.json", "cli");
  add(context.configRoot, "snapshot-share/publish.env", "services.snapshotPublisher", "env");
  add(context.configRoot, "feishu_notify.env", "services.feishu", "env");
  if (selected.backendProfile) {
    const root = selectedDirectory(context, selected.backendProfile);
    add(root, "auth-store.json", "backend.auth");
    add(root, "device-monitor/push.json", "services.pushSender");
    add(root, "agent-team-model-settings.json", "agents.team");
  }
  if (selected.desktopData) {
    const root = selectedDirectory(context, selected.desktopData);
    add(root, "backend-auth.json", "backend.auth");
    add(root, "tunnels/config.json", "desktop.tunnels");
    add(root, "terminal-browser-profiles.json", "desktop.browser");
    add(root, "terminal-browser-proxy.json", "desktop.browser.proxy");
    add(root, "desktop-companion.json", "desktop.preferences.companion");
  }
  return sources;
}

export function retainSelectedStorage(context: EnvironmentContext, selected: SelectedMigrationPaths, draft: MigrationDraft): void {
  if (!selected.backendProfile || draft.value.migrations.storage) return;
  const profile = selectedDirectory(context, selected.backendProfile);
  // A directory selected by accident must not create a new, empty identity.
  if (!existsSync(path.join(profile, "auth-store.json"))) throw new ConfigurationError("CONFIG_SELECTED_PROFILE_UNVERIFIED");
  const globalRoot = context.kind === "stable" ? path.join(os.userInfo().homedir, ".runweave") : path.join(context.configRoot, "data");
  const retained = {
    "storage.browserProfileDirectory": profile,
    "storage.authStoreFile": path.join(profile, "auth-store.json"),
    "storage.terminalSessionStoreFile": path.join(profile, "terminal-session-store.json"),
    "storage.terminalQuickInputStoreFile": path.join(profile, "terminal-quick-inputs.json"),
    "storage.scheduledTasksDirectory": path.join(profile, "scheduled-tasks"),
    "storage.activityDirectory": path.join(globalRoot, "activity"),
    "storage.evolutionDirectory": path.join(globalRoot, "evolution"),
    "storage.experienceDirectory": path.join(globalRoot, "experience"),
    "storage.feishuDirectory": path.join(globalRoot, "feishu"),
    "logging.backendDirectory": path.join(profile, "logs", "backend"),
  };
  // Explicit source manifests/env imports retain their custom paths. The preview
  // shows every chosen path before commit; no database or Cookie is moved.
  for (const [key, value] of Object.entries(retained)) if (readConfigurationPath(draft.value, key) == null) setConfigurationValue(draft.value, key, value);
  const digest = createHash("sha256").update(JSON.stringify(draft.value.storage)).digest("hex");
  draft.value.migrations.storage = { id: `selected-profile:${digest}`, sourceDigest: digest };
}

function selectedDirectory(context: EnvironmentContext, directory: string): string {
  if (!path.isAbsolute(directory) || !existsSync(directory) || !statSync(directory).isDirectory()) throw new ConfigurationError("CONFIG_SOURCE_DIRECTORY_INVALID");
  const result = canonicalPath(directory);
  assertOwnedPath(context, result);
  return result;
}
