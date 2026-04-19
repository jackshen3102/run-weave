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

interface TerminalSessionNameContext {
  cwd?: string;
  command?: string;
}

function basename(value: string | undefined): string | null {
  const normalized = value?.trim().replace(/[\\/]+$/, "");
  if (!normalized) {
    return null;
  }

  return normalized.split(/[\\/]/).filter(Boolean).at(-1) ?? normalized;
}

function isCommandDerivedName(
  name: string,
  context: TerminalSessionNameContext | undefined,
): boolean {
  const command = context?.command?.trim();
  if (!command) {
    return false;
  }

  return name === command || name === basename(command);
}

export function formatTerminalSessionName(
  name: string,
  context?: TerminalSessionNameContext,
): string {
  const trimmedName = name.trim();
  if (isCommandDerivedName(trimmedName, context)) {
    return basename(context?.cwd) ?? name;
  }

  const wrappedMatch = LEGACY_WRAPPED_COMMAND_RE.exec(trimmedName);
  if (wrappedMatch) {
    const directoryName = wrappedMatch[1];
    const commandName = wrappedMatch[2];
    if (
      directoryName &&
      commandName &&
      LEGACY_COMMAND_SUFFIXES.has(commandName)
    ) {
      return `${directoryName}(${commandName})`;
    }
  }

  const match = LEGACY_UNDERSCORE_NAME_RE.exec(trimmedName);
  if (!match) {
    return name;
  }

  const directoryName = match[1];
  const commandName = match[2];
  if (!directoryName || !commandName) {
    return name;
  }
  if (!LEGACY_COMMAND_SUFFIXES.has(commandName)) {
    return name;
  }

  if (INTERACTIVE_SHELL_SUFFIXES.has(commandName)) {
    return directoryName;
  }

  return `${directoryName}(${commandName})`;
}
