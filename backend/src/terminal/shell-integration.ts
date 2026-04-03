import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ESC = "\\u001b";
const BEL = "\\u0007";
const OSC_7_PATTERN = new RegExp(
  `${ESC}]7;(file:\\/\\/[^${BEL}${ESC}]+)(?:${BEL}|${ESC}\\\\)`,
  "g",
);
const ZSH_HOOK_PREFIX = "browser-viewer-zsh-";

function buildDirectoryLabel(cwd: string): string {
  const normalized = cwd.replace(/\/+$/, "") || cwd;
  const baseName = path.basename(normalized);
  return baseName || normalized || "/";
}

export function extractShellPromptMetadata(chunk: string): {
  output: string;
  cwd: string | null;
  sessionName: string | null;
} {
  let cwd: string | null = null;
  const output = chunk.replaceAll(OSC_7_PATTERN, (_match, rawUrl: string) => {
    try {
      const parsedUrl = new URL(rawUrl);
      cwd = decodeURIComponent(parsedUrl.pathname);
    } catch {
      cwd = null;
    }

    return "";
  });

  return {
    output,
    cwd,
    sessionName: cwd ? buildDirectoryLabel(cwd) : null,
  };
}

let cachedZshHookDir: string | null = null;

function ensureZshHookDirectory(): string {
  if (cachedZshHookDir) {
    return cachedZshHookDir;
  }

  const hookDir = mkdtempSync(path.join(os.tmpdir(), ZSH_HOOK_PREFIX));
  const hookScript = [
    'typeset -ga precmd_functions',
    '_browser_viewer_emit_cwd() {',
    '  printf "\\033]7;file://%s%s\\007" "${HOST:-localhost}" "$PWD"',
    '}',
    'if [[ "${precmd_functions[(Ie)_browser_viewer_emit_cwd]}" -eq 0 ]]; then',
    '  precmd_functions+=(_browser_viewer_emit_cwd)',
    "fi",
    "_browser_viewer_emit_cwd",
    'if [[ -n "${BROWSER_VIEWER_ORIGINAL_ZDOTDIR:-}" ]]; then',
    '  export ZDOTDIR="${BROWSER_VIEWER_ORIGINAL_ZDOTDIR}"',
    "else",
    "  unset ZDOTDIR",
    "fi",
    'if [[ -r "${ZDOTDIR:-$HOME}/.zshenv" ]]; then',
    '  source "${ZDOTDIR:-$HOME}/.zshenv"',
    "fi",
    "",
  ].join("\n");

  writeFileSync(path.join(hookDir, ".zshenv"), hookScript, "utf8");
  cachedZshHookDir = hookDir;
  return hookDir;
}

export function applyShellIntegration(
  command: string,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const shellName = path.basename(command);

  if (shellName === "zsh") {
    return {
      ...env,
      BROWSER_VIEWER_ORIGINAL_ZDOTDIR: env.ZDOTDIR ?? "",
      ZDOTDIR: ensureZshHookDirectory(),
    };
  }

  if (shellName === "bash") {
    const emitCwdCommand =
      'printf "\\033]7;file://%s%s\\007" "${HOSTNAME:-localhost}" "$PWD"';
    const existingPromptCommand = env.PROMPT_COMMAND?.trim();
    return {
      ...env,
      PROMPT_COMMAND: existingPromptCommand
        ? `${emitCwdCommand};${existingPromptCommand}`
        : emitCwdCommand,
    };
  }

  return env;
}
