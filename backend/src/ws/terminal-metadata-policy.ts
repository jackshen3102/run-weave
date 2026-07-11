const NODE_WRAPPED_ACTIVE_COMMANDS = new Set([
  "codex",
  "npm",
  "npx",
  "pnpm",
  "trae",
  "traecli",
  "traex",
  "yarn",
]);

function commandBasename(command: string | null): string | null {
  const normalized = command?.trim().replace(/\\+/g, "/");
  if (!normalized) {
    return null;
  }
  return normalized.split("/").filter(Boolean).at(-1) ?? normalized;
}

export function shouldKeepExistingActiveCommand(
  existingActiveCommand: string | null,
  nextActiveCommand: string | null,
  nextActiveCommandSource?: "runweave_command" | "pane_current_command" | null,
): boolean {
  return (
    nextActiveCommandSource === "pane_current_command" &&
    commandBasename(nextActiveCommand) === "node" &&
    NODE_WRAPPED_ACTIVE_COMMANDS.has(
      commandBasename(existingActiveCommand) ?? "",
    )
  );
}
