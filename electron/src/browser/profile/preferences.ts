import { BrowserWindow } from "electron";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import {
  desktopStateRoot,
  writePrivateJson,
} from "../../desktop/local-state.js";
import { getProfileWhistlePorts } from "./endpoints.js";
import path from "node:path";
import {
  createDefaultTerminalBrowserProfilePreferences,
  isTerminalBrowserProfileId,
  TERMINAL_BROWSER_PROFILE_IDENTIFIER_MAX_LENGTH,
  type TerminalBrowserProfileId,
  type TerminalBrowserProfilePreferenceUpdate,
  type TerminalBrowserProfilePreferences,
  type TerminalBrowserProfileProxyMode,
  type TerminalBrowserWorktreePreference,
} from "@runweave/shared/terminal-browser-profile";
import { TerminalBrowserError } from "../errors.js";

const STORE_FILE = "terminal-browser-profiles.json";
let currentPreferences: TerminalBrowserProfilePreferences | null = null;

function storePath(): string {
  return path.join(desktopStateRoot(), STORE_FILE);
}

function clonePreferences(
  preferences: TerminalBrowserProfilePreferences,
): TerminalBrowserProfilePreferences {
  return structuredClone(preferences);
}

export function normalizeTerminalBrowserProjectId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > TERMINAL_BROWSER_PROFILE_IDENTIFIER_MAX_LENGTH ||
    value.trim() !== value
  ) {
    throw new TerminalBrowserError(
      "INVALID_PROJECT_ID",
      "projectId must be a non-empty opaque identifier of at most 512 characters",
      { projectId: typeof value === "string" ? value.slice(0, 64) : null },
    );
  }
  return value;
}

export function normalizeTerminalBrowserGroupId(value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (
    typeof value !== "string" ||
    value.length > TERMINAL_BROWSER_PROFILE_IDENTIFIER_MAX_LENGTH ||
    value.trim() !== value
  ) {
    throw new TerminalBrowserError(
      "INVALID_BROWSER_GROUP_ID",
      "browserGroupId must be at most 512 characters",
      {},
    );
  }
  return value;
}

export function normalizeTerminalBrowserBusinessOrigin(
  value: unknown,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new TerminalBrowserError(
      "INVALID_BUSINESS_ORIGIN",
      "Business origin must be an http or https origin",
    );
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  try {
    const parsed = new URL(normalized);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("not an origin");
    }
    return parsed.origin;
  } catch {
    throw new TerminalBrowserError(
      "INVALID_BUSINESS_ORIGIN",
      "Business origin must be an http or https URL without path, query, or hash",
      { value: normalized.slice(0, 200) },
    );
  }
}

export function normalizeTerminalBrowserDevServerPort(
  value: unknown,
): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 65535 ||
    getProfileWhistlePorts().includes(value)
  ) {
    throw new TerminalBrowserError(
      "INVALID_DEV_SERVER_PORT",
      "Dev Server port must be an integer from 1 to 65535 and cannot use a Profile proxy listening port",
      { value },
    );
  }
  return value;
}

function normalizeWorktreePreference(
  value: unknown,
): TerminalBrowserWorktreePreference {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid worktree preference");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.preferredProfileId !== null &&
    !isTerminalBrowserProfileId(candidate.preferredProfileId)
  ) {
    throw new Error("Invalid worktree profile");
  }
  return {
    preferredProfileId:
      candidate.preferredProfileId as TerminalBrowserProfileId | null,
  };
}

function normalizePersistedPreferences(
  value: unknown,
): TerminalBrowserProfilePreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid profile preferences");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 2 ||
    !isTerminalBrowserProfileId(candidate.defaultProfileId) ||
    !candidate.worktrees ||
    typeof candidate.worktrees !== "object" ||
    Array.isArray(candidate.worktrees)
  ) {
    throw new Error("Invalid profile preferences");
  }
  const proxyModes: Partial<
    Record<TerminalBrowserProfileId, TerminalBrowserProfileProxyMode>
  > = {};
  if (candidate.proxyModes !== undefined) {
    if (
      !candidate.proxyModes ||
      typeof candidate.proxyModes !== "object" ||
      Array.isArray(candidate.proxyModes)
    ) {
      throw new Error("Invalid profile proxy modes");
    }
    for (const [profileId, mode] of Object.entries(candidate.proxyModes)) {
      if (
        !isTerminalBrowserProfileId(profileId) ||
        (mode !== "direct" && mode !== "whistle")
      ) {
        throw new Error("Invalid profile proxy mode");
      }
      proxyModes[profileId] = mode;
    }
  }
  const worktrees: Record<string, TerminalBrowserWorktreePreference> = {};
  for (const [projectId, preference] of Object.entries(candidate.worktrees)) {
    normalizeTerminalBrowserProjectId(projectId);
    worktrees[projectId] = normalizeWorktreePreference(preference);
  }
  const profilePorts: TerminalBrowserProfilePreferences["profilePorts"] = {};
  const pendingPortMigration: TerminalBrowserProfilePreferences["pendingPortMigration"] =
    {};
  for (const [id, value] of Object.entries(candidate.profilePorts ?? {})) {
    if (!isTerminalBrowserProfileId(id))
      throw new Error("Invalid profile port");
    profilePorts[id] = normalizeTerminalBrowserDevServerPort(value);
  }
  for (const [id, value] of Object.entries(
    candidate.pendingPortMigration ?? {},
  )) {
    if (!isTerminalBrowserProfileId(id) || !Array.isArray(value))
      throw new Error("Invalid pending migration");
    pendingPortMigration[id] = value.map((port) => {
      const normalized = normalizeTerminalBrowserDevServerPort(port);
      if (!normalized) throw new Error("Invalid migration port");
      return normalized;
    });
  }
  return {
    version: 2,
    profilePorts,
    pendingPortMigration,
    defaultProfileId: candidate.defaultProfileId,
    businessOrigin: normalizeTerminalBrowserBusinessOrigin(
      candidate.businessOrigin,
    ),
    proxyModes,
    worktrees,
  };
}

function backupUnreadableStore(target: string): void {
  const backupPath = `${target}.bad-${Date.now()}`;
  try {
    copyFileSync(target, backupPath);
    console.warn("[electron] backed up invalid terminal browser profiles", {
      backupPath,
    });
  } catch (error) {
    console.warn("[electron] failed to back up terminal browser profiles", {
      path: target,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function loadPreferences(): TerminalBrowserProfilePreferences {
  const target = storePath();
  try {
    const raw = JSON.parse(readFileSync(target, "utf8"));
    if (raw?.version === 1) return importLegacyPreferences(target, raw);
    return normalizePersistedPreferences(raw);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return createDefaultTerminalBrowserProfilePreferences();
    }
    console.warn("[electron] failed to read terminal browser profiles", {
      path: target,
      error: error instanceof Error ? error.message : String(error),
    });
    backupUnreadableStore(target);
    throw new TerminalBrowserError(
      "PROFILE_CONFIG_CORRUPT",
      "Browser 配置损坏，已保留原文件，请从备份恢复",
      {},
    );
  }
}

function persistPreferences(
  preferences: TerminalBrowserProfilePreferences,
): void {
  const target = storePath();
  try {
    if (existsSync(target))
      writePrivateJson(
        `${target}.bak`,
        JSON.parse(readFileSync(target, "utf8")),
      );
    writePrivateJson(target, preferences);
  } catch {
    throw new TerminalBrowserError(
      "PROFILE_CONFIG_WRITE_FAILED",
      "Browser 配置未保存，原配置保持不变",
      {},
    );
  }
}

function notifyPreferencesChanged(
  preferences: TerminalBrowserProfilePreferences,
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send("terminal-browser:profile-changed", {
        kind: "preferences",
        preferences,
      });
    }
  }
}

let preferenceLoadError: unknown = null;
export function getTerminalBrowserProfilePreferences(): TerminalBrowserProfilePreferences {
  if (preferenceLoadError) throw preferenceLoadError;
  try {
    currentPreferences ??= loadPreferences();
  } catch (error) {
    preferenceLoadError = error;
    throw error;
  }
  return clonePreferences(currentPreferences);
}

export function saveTerminalBrowserProfileProxyMode(
  profileId: TerminalBrowserProfileId,
  proxyMode: TerminalBrowserProfileProxyMode,
): void {
  const next = getTerminalBrowserProfilePreferences();
  if (next.proxyModes?.[profileId] === proxyMode) return;
  next.proxyModes = { ...next.proxyModes, [profileId]: proxyMode };
  persistPreferences(next);
  currentPreferences = next;
  notifyPreferencesChanged(clonePreferences(next));
}

export function updateTerminalBrowserProfilePreferences(
  update: TerminalBrowserProfilePreferenceUpdate,
): TerminalBrowserProfilePreferences {
  if (!update || typeof update !== "object") {
    throw new Error("Invalid terminal browser profile preference update");
  }
  const current = getTerminalBrowserProfilePreferences();
  const next = clonePreferences(current);
  if (update.scope === "global") {
    if (
      update.defaultProfileId !== undefined &&
      !isTerminalBrowserProfileId(update.defaultProfileId)
    ) {
      throw new TerminalBrowserError(
        "INVALID_BROWSER_PROFILE",
        "Unknown Terminal Browser Profile",
        { profileId: update.defaultProfileId },
      );
    }
    if (update.defaultProfileId !== undefined) {
      next.defaultProfileId = update.defaultProfileId;
    }
    if (update.businessOrigin !== undefined) {
      next.businessOrigin = normalizeTerminalBrowserBusinessOrigin(
        update.businessOrigin,
      );
    }
  } else if (update.scope === "worktree") {
    const projectId = normalizeTerminalBrowserProjectId(update.projectId);
    const existing = next.worktrees[projectId] ?? {
      preferredProfileId: null,
    };
    const preferredProfileId =
      update.preferredProfileId === undefined
        ? existing.preferredProfileId
        : update.preferredProfileId;
    if (
      preferredProfileId !== null &&
      !isTerminalBrowserProfileId(preferredProfileId)
    ) {
      throw new TerminalBrowserError(
        "INVALID_BROWSER_PROFILE",
        "Unknown Terminal Browser Profile",
        { profileId: preferredProfileId },
      );
    }
    if (preferredProfileId === null) delete next.worktrees[projectId];
    else next.worktrees[projectId] = { preferredProfileId };
  } else if (update.scope === "profile") {
    if (!isTerminalBrowserProfileId(update.profileId))
      throw new TerminalBrowserError(
        "INVALID_BROWSER_PROFILE",
        "Unknown Profile",
      );
    next.profilePorts[update.profileId] = normalizeTerminalBrowserDevServerPort(
      update.devServerPort,
    );
    delete next.pendingPortMigration[update.profileId];
  } else {
    throw new Error("Invalid terminal browser profile preference scope");
  }
  persistPreferences(next);
  currentPreferences = next;
  notifyPreferencesChanged(clonePreferences(next));
  return clonePreferences(next);
}

// One-time schema import: keep the complete old file as a private backup. Port
// candidates remain pending until explicitly selected; runtime never reads them.
function importLegacyPreferences(
  target: string,
  raw: Record<string, unknown>,
): TerminalBrowserProfilePreferences {
  const pending: TerminalBrowserProfilePreferences["pendingPortMigration"] = {};
  const worktrees: Record<string, TerminalBrowserWorktreePreference> = {};
  if (
    !raw.worktrees ||
    typeof raw.worktrees !== "object" ||
    !isTerminalBrowserProfileId(raw.defaultProfileId)
  )
    throw new Error("Invalid legacy preferences");
  for (const [id, entry] of Object.entries(raw.worktrees)) {
    const value = entry as {
      preferredProfileId: TerminalBrowserProfileId | null;
      devServerPort: unknown;
    };
    normalizeTerminalBrowserProjectId(id);
    worktrees[id] = normalizeWorktreePreference(value);
    const port = normalizeTerminalBrowserDevServerPort(value.devServerPort);
    if (port) {
      const profile = value.preferredProfileId ?? raw.defaultProfileId;
      pending[profile] = [...new Set([...(pending[profile] ?? []), port])];
    }
  }
  const next = normalizePersistedPreferences({
    ...raw,
    version: 2,
    worktrees,
    profilePorts: {},
    pendingPortMigration: pending,
  });
  writePrivateJson(`${target}.v1-backup`, raw);
  writePrivateJson(target, next);
  return next;
}

export function restoreTerminalBrowserProfilePreferences(): TerminalBrowserProfilePreferences {
  const target = storePath();
  let recovered: TerminalBrowserProfilePreferences;
  try {
    recovered = normalizePersistedPreferences(
      JSON.parse(readFileSync(`${target}.bak`, "utf8")),
    );
  } catch {
    throw new TerminalBrowserError(
      "PROFILE_CONFIG_CORRUPT",
      "没有有效的配置备份，请保留当前文件并手动恢复",
    );
  }
  if (existsSync(target)) copyFileSync(target, `${target}.bad-${Date.now()}`);
  writePrivateJson(target, recovered);
  currentPreferences = recovered;
  preferenceLoadError = null;
  notifyPreferencesChanged(clonePreferences(recovered));
  return clonePreferences(recovered);
}
