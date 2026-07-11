import path from "node:path";
import type {
  PersistedTerminalSessionMetadataRecord,
  PersistedTerminalSessionRecord,
} from "./store";

export function toMetadataRecord(
  session: PersistedTerminalSessionRecord,
): PersistedTerminalSessionMetadataRecord {
  return {
    id: session.id,
    projectId: session.projectId,
    alias: session.alias ?? null,
    command: session.command,
    args: [...session.args],
    cwd: session.cwd,
    activeCommand: session.activeCommand ?? null,
    status: session.status,
    createdAt: session.createdAt,
    ...(session.order !== undefined ? { order: session.order } : {}),
    ...(session.lastActivityAt !== undefined
      ? { lastActivityAt: session.lastActivityAt }
      : {}),
    ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
    ...(session.runtimeKind !== undefined
      ? { runtimeKind: session.runtimeKind }
      : {}),
    ...(session.tmuxSessionName !== undefined
      ? { tmuxSessionName: session.tmuxSessionName }
      : {}),
    ...(session.tmuxSocketPath !== undefined
      ? { tmuxSocketPath: session.tmuxSocketPath }
      : {}),
    ...(session.tmuxUnavailableReason !== undefined
      ? { tmuxUnavailableReason: session.tmuxUnavailableReason }
      : {}),
    ...(session.recoverable !== undefined
      ? { recoverable: session.recoverable }
      : {}),
    ...(session.terminalState !== undefined
      ? { terminalState: session.terminalState }
      : {}),
  };
}

const LEGACY_COMMAND_SUFFIXES = new Set([
  "bash",
  "bun",
  "codex",
  "coco",
  "deno",
  "fish",
  "git",
  "node",
  "npm",
  "pnpm",
  "python",
  "python3",
  "sh",
  "vim",
  "zsh",
]);
const INTERACTIVE_SHELL_SUFFIXES = new Set(["bash", "fish", "sh", "zsh"]);
const LEGACY_UNDERSCORE_NAME_RE = /^(.+)_([A-Za-z][A-Za-z0-9.-]*)$/;
const LEGACY_WRAPPED_COMMAND_RE =
  /^(.+)_([A-Za-z][A-Za-z0-9.-]*)\((node|bun)\)$/;

function buildDirectoryLabel(cwd: string): string {
  const normalized = cwd.replace(/\/+$/, "") || cwd;
  const baseName = path.basename(normalized);
  return baseName || normalized || "/";
}

function basename(value: string): string {
  return (
    value
      .trim()
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .filter(Boolean)
      .at(-1) ?? value
  );
}

function normalizeLegacyCommand(command: string | undefined): string | null {
  if (!command || !LEGACY_COMMAND_SUFFIXES.has(command)) {
    return null;
  }
  return INTERACTIVE_SHELL_SUFFIXES.has(command) ? null : command;
}

export function normalizeActiveCommand(params: {
  activeCommand?: string | null;
  command: string;
  cwd: string;
  legacyName?: string;
}): string | null {
  const activeCommand = params.activeCommand?.trim();
  if (activeCommand) {
    return activeCommand;
  }

  const legacyName = params.legacyName?.trim();
  if (!legacyName) {
    return null;
  }

  if (
    legacyName === params.command ||
    legacyName === basename(params.command)
  ) {
    return null;
  }

  const directoryLabel = buildDirectoryLabel(params.cwd);
  if (legacyName === directoryLabel) {
    return null;
  }

  if (legacyName.startsWith(`${directoryLabel}(`) && legacyName.endsWith(")")) {
    return normalizeLegacyCommand(
      legacyName.slice(directoryLabel.length + 1, -1),
    );
  }

  const wrappedMatch = LEGACY_WRAPPED_COMMAND_RE.exec(legacyName);
  if (wrappedMatch?.[1] === directoryLabel) {
    return normalizeLegacyCommand(wrappedMatch[2]);
  }

  const underscoreMatch = LEGACY_UNDERSCORE_NAME_RE.exec(legacyName);
  if (underscoreMatch?.[1] === directoryLabel) {
    return normalizeLegacyCommand(underscoreMatch[2]);
  }

  return null;
}
