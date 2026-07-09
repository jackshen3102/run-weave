import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ESC = "\\u001b";
const BEL = "\\u0007";
const OSC_7_PATTERN = new RegExp(
  `${ESC}]7;(file:\\/\\/[^${BEL}${ESC}]+)(?:${BEL}|${ESC}\\\\)`,
  "g",
);
const OSC_COMMAND_PATTERN = new RegExp(
  `${ESC}]633;(?:RunweaveCommand|BrowserViewerCommand)=([^${BEL}${ESC}]*)(?:${BEL}|${ESC}\\\\)`,
  "g",
);
const ZSH_HOOK_PREFIX = "runweave-zsh-";

export function buildDirectoryLabel(cwd: string): string {
  const normalized = cwd.replace(/\/+$/, "") || cwd;
  const baseName = path.basename(normalized);
  return baseName || normalized || "/";
}

interface ShellPromptTrackerState {
  cwd: string | null;
  activeCommand: string | null;
}

export function createShellPromptTracker(
  initialState?: Partial<ShellPromptTrackerState>,
): {
  consume(chunk: string): {
    output: string;
    cwd: string | null;
    activeCommand: string | null;
    metadataChanged: boolean;
  };
} {
  const state: ShellPromptTrackerState = {
    cwd: initialState?.cwd ?? null,
    activeCommand: initialState?.activeCommand ?? null,
  };

  return {
    consume(chunk: string) {
      let metadataChanged = false;
      const outputWithoutCwd = chunk.replaceAll(
        OSC_7_PATTERN,
        (_match, rawUrl: string) => {
          try {
            const parsedUrl = new URL(rawUrl);
            const nextCwd = decodeURIComponent(parsedUrl.pathname);
            if (nextCwd !== state.cwd) {
              state.cwd = nextCwd;
              metadataChanged = true;
            }
          } catch {
            // Ignore malformed cwd markers and keep the previous metadata state.
          }

          return "";
        },
      );

      const output = outputWithoutCwd.replaceAll(
        OSC_COMMAND_PATTERN,
        (_match, rawCommand: string) => {
          const nextCommand = rawCommand.trim() ? rawCommand.trim() : null;
          if (nextCommand !== state.activeCommand) {
            state.activeCommand = nextCommand;
            metadataChanged = true;
          }

          return "";
        },
      );

      return {
        output,
        cwd: state.cwd,
        activeCommand: state.activeCommand,
        metadataChanged,
      };
    },
  };
}

export function extractShellPromptMetadata(chunk: string): {
  output: string;
  cwd: string | null;
  activeCommand: string | null;
} {
  const tracker = createShellPromptTracker();
  const metadata = tracker.consume(chunk);

  return {
    output: metadata.output,
    cwd: metadata.cwd,
    activeCommand: metadata.activeCommand,
  };
}

let cachedZshHookDir: string | null = null;

function ensureZshHookDirectory(): string {
  if (cachedZshHookDir) {
    return cachedZshHookDir;
  }

  const hookDir = mkdtempSync(path.join(os.tmpdir(), ZSH_HOOK_PREFIX));
  const sourceOriginalScript = (startupFile: string) =>
    [
      '_runweave_original_zdotdir="${RUNWEAVE_ORIGINAL_ZDOTDIR:-${BROWSER_VIEWER_ORIGINAL_ZDOTDIR:-$HOME}}"',
      `if [[ -r "$_runweave_original_zdotdir/${startupFile}" ]]; then`,
      `  source "$_runweave_original_zdotdir/${startupFile}"`,
      "fi",
      `export ZDOTDIR="${hookDir}"`,
      "",
    ].join("\n");
  const zshrcScript = [
    '_runweave_original_zdotdir="${RUNWEAVE_ORIGINAL_ZDOTDIR:-${BROWSER_VIEWER_ORIGINAL_ZDOTDIR:-$HOME}}"',
    'if [[ -r "$_runweave_original_zdotdir/.zshrc" ]]; then',
    '  source "$_runweave_original_zdotdir/.zshrc"',
    "fi",
    'typeset -ga precmd_functions',
    'typeset -ga preexec_functions',
    '_runweave_normalize_command() {',
    '  local raw_command="$1"',
    '  raw_command="${raw_command#"${raw_command%%[![:space:]]*}"}"',
    '  printf "%s" "${raw_command%% *}"',
    '}',
    '_runweave_emit_command() {',
    '  local command="$(_runweave_normalize_command "$1")"',
    '  printf "\\033]633;RunweaveCommand=%s\\007" "$command"',
    '  if [[ -n "${TMUX:-}" && -n "${TMUX_PANE:-}" ]] && command -v tmux >/dev/null 2>&1; then',
    '    tmux set-option -p -q @runweave_command "$command" >/dev/null 2>&1 || true',
    "  fi",
    '}',
    '_runweave_clear_command() {',
    '  printf "\\033]633;RunweaveCommand=\\007"',
    '  if [[ -n "${TMUX:-}" && -n "${TMUX_PANE:-}" ]] && command -v tmux >/dev/null 2>&1; then',
    '    tmux set-option -p -q @runweave_command "" >/dev/null 2>&1 || true',
    "  fi",
    '}',
    '_runweave_emit_cwd() {',
    '  printf "\\033]7;file://%s%s\\007" "${HOST:-localhost}" "$PWD"',
    '}',
    '_runweave_precmd() {',
    '  _runweave_clear_command',
    '  _runweave_emit_cwd',
    '}',
    '_runweave_preexec() {',
    '  _runweave_emit_command "$1"',
    '}',
    'if [[ "${precmd_functions[(Ie)_runweave_precmd]}" -eq 0 ]]; then',
    '  precmd_functions+=(_runweave_precmd)',
    "fi",
    'if [[ "${preexec_functions[(Ie)_runweave_preexec]}" -eq 0 ]]; then',
    '  preexec_functions+=(_runweave_preexec)',
    "fi",
    "_runweave_precmd",
    'if [[ -n "${RUNWEAVE_ORIGINAL_ZDOTDIR:-}" ]]; then',
    '  export ZDOTDIR="${RUNWEAVE_ORIGINAL_ZDOTDIR}"',
    "else",
    "  unset ZDOTDIR",
    "fi",
    "",
  ].join("\n");

  writeFileSync(path.join(hookDir, ".zshenv"), sourceOriginalScript(".zshenv"), "utf8");
  writeFileSync(
    path.join(hookDir, ".zprofile"),
    sourceOriginalScript(".zprofile"),
    "utf8",
  );
  writeFileSync(path.join(hookDir, ".zshrc"), zshrcScript, "utf8");
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
      RUNWEAVE_ORIGINAL_ZDOTDIR: env.ZDOTDIR ?? "",
      ZDOTDIR: ensureZshHookDirectory(),
    };
  }

  if (shellName === "bash") {
    const emitBashHooks = [
      '_runweave_normalize_command() {',
      '  local raw_command="$1"',
      '  raw_command="${raw_command#"${raw_command%%[![:space:]]*}"}"',
      '  printf "%s" "${raw_command%% *}"',
      '}',
      '_runweave_emit_command() {',
      '  local command="$(_runweave_normalize_command "$1")"',
      '  printf "\\033]633;RunweaveCommand=%s\\007" "$command"',
      '  if [[ -n "${TMUX:-}" && -n "${TMUX_PANE:-}" ]] && command -v tmux >/dev/null 2>&1; then',
      '    tmux set-option -p -q @runweave_command "$command" >/dev/null 2>&1 || true',
      "  fi",
      '}',
      '_runweave_clear_command() {',
      '  printf "\\033]633;RunweaveCommand=\\007"',
      '  if [[ -n "${TMUX:-}" && -n "${TMUX_PANE:-}" ]] && command -v tmux >/dev/null 2>&1; then',
      '    tmux set-option -p -q @runweave_command "" >/dev/null 2>&1 || true',
      "  fi",
      '}',
      '_runweave_emit_cwd() {',
      '  printf "\\033]7;file://%s%s\\007" "${HOSTNAME:-localhost}" "$PWD"',
      '}',
      '_runweave_preexec() {',
      '  if [[ -n "${RUNWEAVE_IN_PROMPT_COMMAND:-}" ]]; then',
      "    return",
      "  fi",
      '  local command="$(_runweave_normalize_command "$BASH_COMMAND")"',
      '  if [[ -z "$command" || "$command" == "$RUNWEAVE_LAST_COMMAND" ]]; then',
      "    return",
      "  fi",
      '  RUNWEAVE_LAST_COMMAND="$command"',
      '  _runweave_emit_command "$command"',
      '}',
      '_runweave_precmd() {',
      '  RUNWEAVE_IN_PROMPT_COMMAND=1',
      '  RUNWEAVE_LAST_COMMAND=""',
      '  _runweave_clear_command',
      '  _runweave_emit_cwd',
      '  unset RUNWEAVE_IN_PROMPT_COMMAND',
      '}',
      "trap '_runweave_preexec' DEBUG",
    ].join("\n");
    const existingPromptCommand = env.PROMPT_COMMAND?.trim();
    return {
      ...env,
      RUNWEAVE_LAST_COMMAND: "",
      PROMPT_COMMAND: existingPromptCommand
        ? `${emitBashHooks};_runweave_precmd;${existingPromptCommand}`
        : `${emitBashHooks};_runweave_precmd`,
    };
  }

  return env;
}
