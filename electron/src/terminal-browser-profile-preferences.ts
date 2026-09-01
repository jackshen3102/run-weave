import { app, BrowserWindow } from "electron";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  createDefaultTerminalBrowserProfilePreferences,
  isTerminalBrowserProfileId,
  TERMINAL_BROWSER_PROFILE_CONFIGS,
  TERMINAL_BROWSER_PROFILE_IDENTIFIER_MAX_LENGTH,
  type TerminalBrowserProfileId,
  type TerminalBrowserProfilePreferenceUpdate,
  type TerminalBrowserProfilePreferences,
  type TerminalBrowserWorktreePreference,
} from "@runweave/shared/terminal-browser-profile";
import { TerminalBrowserError } from "./terminal-browser-errors.js";

const STORE_FILE = "terminal-browser-profiles.json";
const RESERVED_PORTS: Set<number> = new Set(
  Object.values(TERMINAL_BROWSER_PROFILE_CONFIGS).map(
    (profile) => profile.whistlePort,
  ),
);

let currentPreferences: TerminalBrowserProfilePreferences | null = null;

function storePath(): string {
  return path.join(app.getPath("userData"), STORE_FILE);
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
    RESERVED_PORTS.has(value)
  ) {
    throw new TerminalBrowserError(
      "INVALID_DEV_SERVER_PORT",
      "Dev Server port must be an integer from 1 to 65535 and cannot use 8081, 8082, or 8083",
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
    devServerPort: normalizeTerminalBrowserDevServerPort(
      candidate.devServerPort,
    ),
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
    candidate.version !== 1 ||
    !isTerminalBrowserProfileId(candidate.defaultProfileId) ||
    !candidate.worktrees ||
    typeof candidate.worktrees !== "object" ||
    Array.isArray(candidate.worktrees)
  ) {
    throw new Error("Invalid profile preferences");
  }
  const worktrees: Record<string, TerminalBrowserWorktreePreference> = {};
  for (const [projectId, preference] of Object.entries(candidate.worktrees)) {
    normalizeTerminalBrowserProjectId(projectId);
    worktrees[projectId] = normalizeWorktreePreference(preference);
  }
  return {
    version: 1,
    defaultProfileId: candidate.defaultProfileId,
    businessOrigin: normalizeTerminalBrowserBusinessOrigin(
      candidate.businessOrigin,
    ),
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
    return normalizePersistedPreferences(
      JSON.parse(readFileSync(target, "utf8")),
    );
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
    return createDefaultTerminalBrowserProfilePreferences();
  }
}

function persistPreferences(
  preferences: TerminalBrowserProfilePreferences,
): void {
  const target = storePath();
  const temporary = `${target}.tmp-${process.pid}`;
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(temporary, `${JSON.stringify(preferences, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
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

export function getTerminalBrowserProfilePreferences(): TerminalBrowserProfilePreferences {
  currentPreferences ??= loadPreferences();
  return clonePreferences(currentPreferences);
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
      devServerPort: null,
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
    const devServerPort =
      update.devServerPort === undefined
        ? existing.devServerPort
        : normalizeTerminalBrowserDevServerPort(update.devServerPort);
    if (preferredProfileId === null && devServerPort === null) {
      delete next.worktrees[projectId];
    } else {
      next.worktrees[projectId] = { preferredProfileId, devServerPort };
    }
  } else {
    throw new Error("Invalid terminal browser profile preference scope");
  }
  persistPreferences(next);
  currentPreferences = next;
  notifyPreferencesChanged(clonePreferences(next));
  return clonePreferences(next);
}
