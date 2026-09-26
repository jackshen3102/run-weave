import { BrowserWindow } from "electron";
import { ConfigurationDomain } from "@runweave/config-node";
import { requireDesktopMigration } from "../../desktop/configuration-migration.js";
import type { ConfigurationValue } from "@runweave/shared/configuration";
import { getProfileWhistlePorts } from "./endpoints.js";
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

const store = new ConfigurationDomain<Partial<TerminalBrowserProfilePreferences>>("desktop.browser");
let currentPreferences: TerminalBrowserProfilePreferences | null = null;
const preferenceKeys = ["defaultProfileId", "businessOrigin", "profilePorts", "proxyModes", "worktrees", "pendingPortMigration"] as const;

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

function loadPreferences(): TerminalBrowserProfilePreferences {
  requireDesktopMigration("desktop.browser.defaultProfileId", "terminal-browser-profiles.json");
  const saved = store.read();
  const defaults = createDefaultTerminalBrowserProfilePreferences();
  const normalized = normalizePersistedPreferences({ ...defaults, ...saved,
    defaultProfileId: saved?.defaultProfileId ?? defaults.defaultProfileId,
    worktrees: saved?.worktrees ?? defaults.worktrees,
    version: 2 });
  store.markApplied(preferenceKeys.map(key => `desktop.browser.${key}`));
  return normalized;
}

function persistPreferences(preferences: TerminalBrowserProfilePreferences): void {
  const changes: Record<string, ConfigurationValue> = {};
  for (const key of preferenceKeys) {
    const value = preferences[key];
    if (value !== undefined) changes[`desktop.browser.${key}`] = value as ConfigurationValue;
  }
  try { store.patch(changes); }
  catch (error) { currentPreferences = null; preferenceLoadError = null; throw error; }
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
  store.markApplied(preferenceKeys.map(key => `desktop.browser.${key}`));
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
  store.markApplied(preferenceKeys.map(key => `desktop.browser.${key}`));
  notifyPreferencesChanged(clonePreferences(next));
  return clonePreferences(next);
}

// Recovery is explicit and uses the private unified-file backup, then retries read.
export function restoreTerminalBrowserProfilePreferences(): TerminalBrowserProfilePreferences {
  store.restore(["defaultProfileId", "businessOrigin", "profilePorts", "proxyModes", "worktrees", "pendingPortMigration"].map((key) => `desktop.browser.${key}`));
  const recovered = loadPreferences();
  currentPreferences = recovered;
  preferenceLoadError = null;
  notifyPreferencesChanged(clonePreferences(recovered));
  return clonePreferences(recovered);
}
