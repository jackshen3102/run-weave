interface TerminalSessionNameContext {
  alias?: string | null;
  cwd?: string;
  activeCommand?: string | null;
}

const INTERACTIVE_SHELL_COMMANDS = new Set(["bash", "fish", "sh", "zsh"]);
const DISPLAY_AGENT_COMMANDS = new Set([
  "claude",
  "codex",
  "trae",
  "traecli",
  "traex",
]);

function basename(value: string | undefined): string | null {
  const normalized = value?.trim().replace(/[\\/]+$/, "");
  if (!normalized) {
    return null;
  }

  return normalized.split(/[\\/]/).filter(Boolean).at(-1) ?? normalized;
}

export function formatTerminalSessionName(
  context: TerminalSessionNameContext,
): string {
  const baseLabel = context.alias?.trim() || basename(context.cwd) || "Terminal";
  const activeCommand = basename(context.activeCommand ?? undefined);
  if (
    !activeCommand ||
    INTERACTIVE_SHELL_COMMANDS.has(activeCommand) ||
    !DISPLAY_AGENT_COMMANDS.has(activeCommand)
  ) {
    return baseLabel;
  }

  return `${baseLabel}(${activeCommand})`;
}
