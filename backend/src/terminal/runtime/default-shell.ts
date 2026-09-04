import { existsSync } from "node:fs";
import path from "node:path";

export interface TerminalLaunchConfig {
  command: string;
  args: string[];
}

function normalizeCommand(command: string): string {
  return command.trim();
}

export function resolveDefaultTerminalCommand(): string {
  if (process.platform === "win32") {
    const configured = process.env.COMSPEC?.trim();
    if (configured) {
      return configured;
    }
    return "powershell.exe";
  }

  const configured = process.env.SHELL?.trim();
  if (configured) {
    return configured;
  }

  return "/bin/bash";
}

export function resolveDefaultTerminalArgs(command: string): string[] {
  const shellName = path.basename(command);
  if (shellName === "zsh" || shellName === "bash") {
    return ["-l"];
  }

  return [];
}

function launchConfigsEqual(
  left: TerminalLaunchConfig,
  right: TerminalLaunchConfig,
): boolean {
  return (
    left.command === right.command &&
    left.args.length === right.args.length &&
    left.args.every((arg, index) => arg === right.args[index])
  );
}

export function resolveDefaultTerminalLaunchConfig(): TerminalLaunchConfig {
  const command = resolveDefaultTerminalCommand();
  return {
    command,
    args: resolveDefaultTerminalArgs(command),
  };
}

function resolvePlatformFallbackCommands(): string[] {
  if (process.platform === "win32") {
    return ["powershell.exe", "cmd.exe"];
  }

  return ["/bin/zsh", "/bin/bash", "/bin/sh"].filter((command) =>
    existsSync(command),
  );
}

export function resolveTerminalFallbackLaunchConfig(current: {
  command: string;
  args?: string[];
}): TerminalLaunchConfig | null {
  const command = normalizeCommand(current.command);
  const args = current.args ?? [];
  const currentLaunch = { command, args };
  const defaultArgs = resolveDefaultTerminalArgs(command);
  const sameCommandDefaultLaunch = {
    command,
    args: defaultArgs,
  };

  if (!launchConfigsEqual(currentLaunch, sameCommandDefaultLaunch)) {
    return sameCommandDefaultLaunch;
  }

  for (const candidateCommand of resolvePlatformFallbackCommands()) {
    const candidateLaunch = {
      command: candidateCommand,
      args: resolveDefaultTerminalArgs(candidateCommand),
    };
    if (!launchConfigsEqual(currentLaunch, candidateLaunch)) {
      return candidateLaunch;
    }
  }

  return null;
}
