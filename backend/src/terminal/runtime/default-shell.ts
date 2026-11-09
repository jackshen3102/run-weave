import { accessSync, constants, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { configuration } from "@runweave/config-node";
import { isInteractiveShellLaunch, terminalShellName } from "@runweave/shared/terminal/shell";
export { terminalShellName } from "@runweave/shared/terminal/shell";
import { logger } from "../../logging/index";

export interface TerminalLaunchConfig {
  command: string;
  args: string[];
}


function isExecutable(file: string): boolean {
  try {
    accessSync(file, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return statSync(file).isFile();
  } catch { return false; }
}

export function resolveTerminalExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (path.isAbsolute(command) || /[\\/]/.test(command)) return isExecutable(command) ? command : undefined;
  const suffixes = process.platform === "win32" ? ["", ".exe", ".com"] : [""];
  for (const directory of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const candidate = path.join(directory, command + suffix);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

/** System policy only: never read the Runweave override during fallback. */
export function resolveSystemTerminalLaunchConfig(): TerminalLaunchConfig {
  const env = process.env;
  let candidates: (string | null | undefined)[];
  if (process.platform === "win32") {
    candidates = [env.ComSpec, env.COMSPEC, "powershell.exe", "cmd.exe"];
  } else {
    let loginShell: string | null = null;
    try { loginShell = os.userInfo().shell; } catch { /* Account lookup may be unavailable in containers. */ }
    candidates = [loginShell, env.SHELL, "/bin/bash", "/bin/sh"];
  }
  const command = candidates.map(candidate => candidate?.trim()).find(candidate => candidate && resolveTerminalExecutable(candidate));
  if (!command) throw new Error("No executable system shell found");
  return { command, args: resolveDefaultTerminalArgs(command) };
}

export function resolveDefaultTerminalArgs(command: string): string[] {
  return ["zsh", "bash"].includes(terminalShellName(command)) ? ["-l"] : [];
}

/** An explicit program never inherits another shell's configured arguments. */
export function resolveTerminalLaunchConfig(overrides: { command?: string; args?: string[] } = {}): TerminalLaunchConfig {
  const explicitCommand = overrides.command?.trim();
  if (explicitCommand) return { command: explicitCommand, args: overrides.args ?? resolveDefaultTerminalArgs(explicitCommand) };
  const launch = resolveDefaultTerminalLaunchConfig();
  return { command: launch.command, args: overrides.args ?? launch.args };
}

export function resolveDefaultTerminalLaunchConfig(): TerminalLaunchConfig {
  const config = configuration();
  config.requireDomain("terminal.defaultShell");
  const command = config.get<string>("terminal.defaultShell.command")?.trim();
  const args = config.get<string[]>("terminal.defaultShell.args");
  if (command && !resolveTerminalExecutable(command)) {
    const fallback = resolveSystemTerminalLaunchConfig();
    logger.warn("terminal.default-shell.unavailable", { message: "Configured shell is unavailable; using system shell", command, fallbackCommand: fallback.command });
    return fallback;
  }
  const selected = command ?? resolveSystemTerminalLaunchConfig().command;
  return { command: selected, args: args ?? resolveDefaultTerminalArgs(selected) };
}

export function resolveTerminalFallbackLaunchConfig(current: { command: string; args?: string[] }): TerminalLaunchConfig | null {
  if (!isInteractiveShellLaunch(current)) return null;
  let fallback: TerminalLaunchConfig;
  try { fallback = resolveSystemTerminalLaunchConfig(); } catch { return null; }
  const args = current.args ?? [];
  return current.command.trim() === fallback.command && args.length === fallback.args.length && args.every((arg, i) => arg === fallback.args[i])
    ? null : fallback;
}
