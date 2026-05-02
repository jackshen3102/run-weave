import path from "node:path";

const INTERACTIVE_SHELL_COMMANDS = new Set(["bash", "zsh", "sh", "fish"]);

export function getInitialTerminalActiveCommand(command: string): string | null {
  const commandName = path.basename(command.trim());
  if (!commandName || INTERACTIVE_SHELL_COMMANDS.has(commandName)) {
    return null;
  }

  return commandName;
}
