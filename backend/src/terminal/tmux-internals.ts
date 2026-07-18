import { accessSync, constants } from "node:fs";
import path from "node:path";
import { logger } from "../logging";
import type {
  TmuxLaunchCommand,
  TmuxPaneMetadata,
  TmuxPaneTarget,
  TmuxTarget,
} from "./tmux-types";

export const RUNWEAVE_TMUX_PREFIX = "runweave-";
export const TmuxCommandTimeoutMs = 5_000;
export const RebuildWindowMs = 60_000;
export const MaxRebuildAttempts = 3;
export const CaptureHistoryLines = 5_000;
export const InteractivePaneReadyMinWaitMs = 1_000;
export const InteractivePaneReadyStableMs = 200;
export const InteractivePaneReadyTimeoutMs = 2_500;
export const DEFAULT_UTF8_LOCALE = "en_US.UTF-8";
export const TMUX_RUNTIME_OPTION_ARGS = ["set-option", "-g", "mouse", "on"];
export const TMUX_SANITIZE_NPM_PREFIX_ENV_ARGS = [
  "set-environment",
  "-g",
  "-u",
  "npm_config_prefix",
  ";",
  "set-environment",
  "-g",
  "-u",
  "NPM_CONFIG_PREFIX",
  ";",
  "set-environment",
  "-g",
  "-u",
  "NO_COLOR",
  ";",
  "set-environment",
  "-g",
  "-u",
  "FORCE_COLOR",
  ";",
  "set-environment",
  "-g",
  "-u",
  "CLICOLOR",
  ";",
  "set-environment",
  "-g",
  "-u",
  "ELECTRON_RUN_AS_NODE",
  ";",
  "set-environment",
  "-g",
  "-u",
  "FRONTEND_DIST_DIR",
  ";",
];
export const TMUX_METADATA_FIELD_SEPARATOR = "__RUNWEAVE_METADATA_FIELD__";
// Keep literal send-keys arguments below tmux's command parser limit. The
// limit is byte-based, so this must be applied to UTF-8 bytes rather than JS
// string length.
export const TMUX_SEND_KEYS_MAX_CHUNK_BYTES = 8 * 1024;
export const SHELL_INTEGRATION_ENV_KEYS = [
  "RUNWEAVE_LAST_COMMAND",
  "RUNWEAVE_ORIGINAL_ZDOTDIR",
  "BROWSER_VIEWER_LAST_COMMAND",
  "BROWSER_VIEWER_ORIGINAL_ZDOTDIR",
  "PROMPT_COMMAND",
  "ZDOTDIR",
];
export const tmuxLogger = logger.child({ component: "terminal" });

export function isExecutablePath(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function isUnsetEnvValue(value: string | undefined): boolean {
  if (value === undefined) {
    return true;
  }
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "" || normalized === "undefined" || normalized === "null"
  );
}

export function isUtf8Locale(value: string | undefined): boolean {
  const normalized = value?.trim();
  if (!normalized) {
    return false;
  }
  const lowerValue = normalized.toLowerCase();
  if (lowerValue === "undefined" || lowerValue === "null") {
    return false;
  }
  return /utf-?8/i.test(normalized);
}

export function resolveUtf8Locale(env: NodeJS.ProcessEnv): string {
  return (
    [env.LC_ALL, env.LC_CTYPE, env.LANG].find(isUtf8Locale)?.trim() ??
    DEFAULT_UTF8_LOCALE
  );
}

export function resolveExecutableFromPath(
  command: string,
  env: NodeJS.ProcessEnv,
): string {
  if (command.includes(path.sep)) {
    return command;
  }

  for (const entry of (env.PATH ?? "").split(path.delimiter)) {
    const directory = entry.trim();
    if (!directory) {
      continue;
    }
    const candidate = path.join(directory, command);
    if (isExecutablePath(candidate)) {
      return candidate;
    }
  }

  return command;
}

export function describeTmuxInputChunk(
  chunk: ReturnType<typeof splitInputForSendKeys>[number],
) {
  if (chunk.type === "enter") {
    return { type: "enter" };
  }

  return {
    type: "literal",
    byteLength: Buffer.byteLength(chunk.value, "utf8"),
    charLength: chunk.value.length,
    firstCodePoints: Array.from(chunk.value.slice(0, 8)).map((char) =>
      char.codePointAt(0),
    ),
  };
}

export function resolveTmuxTargetName(
  target: TmuxTarget | TmuxPaneTarget,
): string {
  return "paneId" in target ? target.paneId : target.sessionName;
}

export function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function parseNonNegativeInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function splitInputForSendKeys(
  data: string,
): Array<{ type: "text"; value: string } | { type: "enter" }> {
  const chunks: Array<{ type: "text"; value: string } | { type: "enter" }> = [];
  let start = 0;

  for (let index = 0; index < data.length; index += 1) {
    const char = data[index];
    if (char !== "\r" && char !== "\n") {
      continue;
    }
    if (index > start) {
      appendTextChunks(chunks, data.slice(start, index));
    }
    chunks.push({ type: "enter" });
    if (char === "\r" && data[index + 1] === "\n") {
      index += 1;
    }
    start = index + 1;
  }

  if (start < data.length) {
    appendTextChunks(chunks, data.slice(start));
  }

  return chunks;
}

function appendTextChunks(
  chunks: Array<{ type: "text"; value: string } | { type: "enter" }>,
  value: string,
): void {
  let start = 0;
  let bytes = 0;
  for (let index = 0; index < value.length; ) {
    const codePoint = value.codePointAt(index)!;
    const char = String.fromCodePoint(codePoint);
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes > 0 && bytes + charBytes > TMUX_SEND_KEYS_MAX_CHUNK_BYTES) {
      chunks.push({ type: "text", value: value.slice(start, index) });
      start = index;
      bytes = 0;
    }
    bytes += charBytes;
    index += char.length;
  }
  if (start < value.length) {
    chunks.push({ type: "text", value: value.slice(start) });
  }
}

export async function delayAfterTmuxKey(
  delayAfterMs: number | undefined,
): Promise<void> {
  if (!delayAfterMs) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, delayAfterMs));
}

export function isProcessExitCode(error: unknown, exitCode: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === exitCode
  );
}

export function isTimeoutError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const errorWithDetails = error as {
    signal?: unknown;
    killed?: unknown;
    code?: unknown;
  };
  return (
    errorWithDetails.killed === true ||
    errorWithDetails.signal === "SIGTERM" ||
    errorWithDetails.code === "ETIMEDOUT"
  );
}

export function categorizeTmuxCommand(args: string[]): string {
  const firstCommand = args.find((arg) => !arg.startsWith("-")) ?? "unknown";
  return firstCommand === ";" ? "compound" : firstCommand;
}

export async function delay(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export function formatShellCommand(launchCommand: TmuxLaunchCommand): string {
  const envParts = Object.entries(launchCommand.env ?? {}).flatMap(
    ([key, value]) => (value ? [`${key}=${value}`] : []),
  );
  const commandParts = isInteractiveShellLaunchCommand(launchCommand)
    ? [
        "env",
        "-u",
        "npm_config_prefix",
        "-u",
        "NPM_CONFIG_PREFIX",
        ...envParts,
        launchCommand.command,
        ...launchCommand.args,
      ]
    : envParts.length > 0
      ? ["env", ...envParts, launchCommand.command, ...launchCommand.args]
      : [launchCommand.command, ...launchCommand.args];
  return commandParts.map((part) => shellQuote(part)).join(" ");
}

export function isInteractiveShellLaunchCommand(
  launchCommand: TmuxLaunchCommand,
): boolean {
  const commandName =
    launchCommand.command.split(/[\\/]/).at(-1) ?? launchCommand.command;
  if (!["bash", "zsh", "sh", "fish"].includes(commandName)) {
    return false;
  }
  return !launchCommand.args.some((arg) => arg === "-c" || arg === "-lc");
}

export function normalizePaneCommand(
  paneCommand: string,
  shellCommand?: string,
): string | null {
  const command = paneCommand.trim();
  if (!command) {
    return null;
  }

  const shellName = shellCommand ? path.basename(shellCommand) : null;
  if (shellName && isInteractiveShellName(shellName) && command === shellName) {
    return null;
  }

  return command;
}

export function resolvePaneActiveCommand(
  rawRunweaveCommand: string,
  rawCommand: string,
  shellCommand?: string,
): {
  command: string | null;
  source: TmuxPaneMetadata["activeCommandSource"];
} {
  const runweaveCommand = normalizePaneCommand(rawRunweaveCommand);
  if (runweaveCommand) {
    return { command: runweaveCommand, source: "runweave_command" };
  }

  const paneCommand = normalizePaneCommand(rawCommand, shellCommand);
  if (paneCommand) {
    return { command: paneCommand, source: "pane_current_command" };
  }

  return { command: null, source: null };
}

export function isInteractiveShellName(command: string): boolean {
  return ["bash", "zsh", "sh", "fish"].includes(command);
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
