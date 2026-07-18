const CHILD_PROJECT_ID_PREFIX = "wt";

export type TerminalProjectContextAvailability =
  | "available"
  | "path_unavailable"
  | "missing";

export interface TerminalProjectContextListItem {
  projectId: string;
  parentProjectId: string;
  name: string;
  branch: string | null;
  head: string | null;
  path: string | null;
  isPrimary: boolean;
  pinned: boolean;
  pinOrder: number | null;
  availability: TerminalProjectContextAvailability;
}

export interface ParsedTerminalChildProjectId {
  parentProjectId: string;
  worktreeName: string;
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string): string | null {
  if (!value || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    return null;
  }
  const paddingLength = (4 - (value.length % 4)) % 4;
  try {
    const binary = atob(
      value.replaceAll("-", "+").replaceAll("_", "/") +
        "=".repeat(paddingLength),
    );
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function normalizeWorktreeName(value: string): string {
  return value.normalize("NFC");
}

function isValidWorktreeName(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
}

export function buildTerminalChildProjectId(
  parentProjectId: string,
  worktreeName: string,
): string {
  const normalizedParentProjectId = parentProjectId.trim();
  const normalizedWorktreeName = normalizeWorktreeName(worktreeName);
  if (!normalizedParentProjectId || !isValidWorktreeName(normalizedWorktreeName)) {
    throw new Error("Parent project ID and Worktree name are required");
  }
  return `${CHILD_PROJECT_ID_PREFIX}:${encodeBase64Url(normalizedParentProjectId)}:${encodeBase64Url(normalizedWorktreeName)}`;
}

export function parseTerminalChildProjectId(
  projectId: string,
): ParsedTerminalChildProjectId | null {
  const segments = projectId.split(":");
  if (segments.length !== 3 || segments[0] !== CHILD_PROJECT_ID_PREFIX) {
    return null;
  }
  const parentProjectId = decodeBase64Url(segments[1] ?? "");
  const decodedWorktreeName = decodeBase64Url(segments[2] ?? "");
  if (!parentProjectId?.trim() || decodedWorktreeName === null) {
    return null;
  }
  const worktreeName = normalizeWorktreeName(decodedWorktreeName);
  if (!isValidWorktreeName(worktreeName)) {
    return null;
  }
  try {
    if (buildTerminalChildProjectId(parentProjectId, worktreeName) !== projectId) {
      return null;
    }
  } catch {
    return null;
  }
  return { parentProjectId, worktreeName };
}

export function isTerminalChildProjectIdLike(projectId: string): boolean {
  return projectId.startsWith(`${CHILD_PROJECT_ID_PREFIX}:`);
}

export function resolveTerminalParentProjectId(projectId: string): string {
  return parseTerminalChildProjectId(projectId)?.parentProjectId ?? projectId;
}
