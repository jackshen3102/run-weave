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
  `${ESC}]633;BrowserViewerCommand=([^${BEL}${ESC}]*)(?:${BEL}|${ESC}\\\\)`,
  "g",
);
const ZSH_HOOK_PREFIX = "browser-viewer-zsh-";

export function buildDirectoryLabel(cwd: string): string {
  const normalized = cwd.replace(/\/+$/, "") || cwd;
  const baseName = path.basename(normalized);
  return baseName || normalized || "/";
}

export function buildSessionLabel(
  cwd: string,
  activeCommand: string | null,
): string {
  const directoryLabel = buildDirectoryLabel(cwd);
  return activeCommand
    ? `${directoryLabel}(${activeCommand})`
    : directoryLabel;
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
    sessionName: string | null;
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
        sessionName: state.cwd
          ? buildSessionLabel(state.cwd, state.activeCommand)
          : null,
        metadataChanged,
      };
    },
  };
}

export function extractShellPromptMetadata(chunk: string): {
  output: string;
  cwd: string | null;
  sessionName: string | null;
} {
  const tracker = createShellPromptTracker();
  const metadata = tracker.consume(chunk);

  return {
    output: metadata.output,
    cwd: metadata.cwd,
    sessionName: metadata.sessionName,
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
      '_browser_viewer_original_zdotdir="${BROWSER_VIEWER_ORIGINAL_ZDOTDIR:-$HOME}"',
      `if [[ -r "$_browser_viewer_original_zdotdir/${startupFile}" ]]; then`,
      `  source "$_browser_viewer_original_zdotdir/${startupFile}"`,
      "fi",
      `export ZDOTDIR="${hookDir}"`,
      "",
    ].join("\n");
  const zshrcScript = [
    '_browser_viewer_original_zdotdir="${BROWSER_VIEWER_ORIGINAL_ZDOTDIR:-$HOME}"',
    'if [[ -r "$_browser_viewer_original_zdotdir/.zshrc" ]]; then',
    '  source "$_browser_viewer_original_zdotdir/.zshrc"',
    "fi",
    'typeset -ga precmd_functions',
    'typeset -ga preexec_functions',
    '_browser_viewer_normalize_command() {',
    '  local raw_command="$1"',
    '  raw_command="${raw_command#"${raw_command%%[![:space:]]*}"}"',
    '  printf "%s" "${raw_command%% *}"',
    '}',
    '_browser_viewer_emit_command() {',
    '  local command="$(_browser_viewer_normalize_command "$1")"',
    '  printf "\\033]633;BrowserViewerCommand=%s\\007" "$command"',
    '  if [[ -n "${TMUX:-}" && -n "${TMUX_PANE:-}" ]] && command -v tmux >/dev/null 2>&1; then',
    '    tmux set-option -p -q @runweave_command "$command" >/dev/null 2>&1 || true',
    "  fi",
    '}',
    '_browser_viewer_clear_command() {',
    '  printf "\\033]633;BrowserViewerCommand=\\007"',
    '  if [[ -n "${TMUX:-}" && -n "${TMUX_PANE:-}" ]] && command -v tmux >/dev/null 2>&1; then',
    '    tmux set-option -p -q @runweave_command "" >/dev/null 2>&1 || true',
    "  fi",
    '}',
    '_browser_viewer_emit_cwd() {',
    '  printf "\\033]7;file://%s%s\\007" "${HOST:-localhost}" "$PWD"',
    '}',
    '_browser_viewer_precmd() {',
    '  _browser_viewer_clear_command',
    '  _browser_viewer_emit_cwd',
    '}',
    '_browser_viewer_preexec() {',
    '  _browser_viewer_emit_command "$1"',
    '}',
    'if [[ "${precmd_functions[(Ie)_browser_viewer_precmd]}" -eq 0 ]]; then',
    '  precmd_functions+=(_browser_viewer_precmd)',
    "fi",
    'if [[ "${preexec_functions[(Ie)_browser_viewer_preexec]}" -eq 0 ]]; then',
    '  preexec_functions+=(_browser_viewer_preexec)',
    "fi",
    "_browser_viewer_precmd",
    'if [[ -n "${BROWSER_VIEWER_ORIGINAL_ZDOTDIR:-}" ]]; then',
    '  export ZDOTDIR="${BROWSER_VIEWER_ORIGINAL_ZDOTDIR}"',
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
      BROWSER_VIEWER_ORIGINAL_ZDOTDIR: env.ZDOTDIR ?? "",
      ZDOTDIR: ensureZshHookDirectory(),
    };
  }

  if (shellName === "bash") {
    const emitBashHooks = [
      '_browser_viewer_normalize_command() {',
      '  local raw_command="$1"',
      '  raw_command="${raw_command#"${raw_command%%[![:space:]]*}"}"',
      '  printf "%s" "${raw_command%% *}"',
      '}',
      '_browser_viewer_emit_command() {',
      '  local command="$(_browser_viewer_normalize_command "$1")"',
      '  printf "\\033]633;BrowserViewerCommand=%s\\007" "$command"',
      '  if [[ -n "${TMUX:-}" && -n "${TMUX_PANE:-}" ]] && command -v tmux >/dev/null 2>&1; then',
      '    tmux set-option -p -q @runweave_command "$command" >/dev/null 2>&1 || true',
      "  fi",
      '}',
      '_browser_viewer_clear_command() {',
      '  printf "\\033]633;BrowserViewerCommand=\\007"',
      '  if [[ -n "${TMUX:-}" && -n "${TMUX_PANE:-}" ]] && command -v tmux >/dev/null 2>&1; then',
      '    tmux set-option -p -q @runweave_command "" >/dev/null 2>&1 || true',
      "  fi",
      '}',
      '_browser_viewer_emit_cwd() {',
      '  printf "\\033]7;file://%s%s\\007" "${HOSTNAME:-localhost}" "$PWD"',
      '}',
      '_browser_viewer_preexec() {',
      '  if [[ -n "${BROWSER_VIEWER_IN_PROMPT_COMMAND:-}" ]]; then',
      "    return",
      "  fi",
      '  local command="$(_browser_viewer_normalize_command "$BASH_COMMAND")"',
      '  if [[ -z "$command" || "$command" == "$BROWSER_VIEWER_LAST_COMMAND" ]]; then',
      "    return",
      "  fi",
      '  BROWSER_VIEWER_LAST_COMMAND="$command"',
      '  _browser_viewer_emit_command "$command"',
      '}',
      '_browser_viewer_precmd() {',
      '  BROWSER_VIEWER_IN_PROMPT_COMMAND=1',
      '  BROWSER_VIEWER_LAST_COMMAND=""',
      '  _browser_viewer_clear_command',
      '  _browser_viewer_emit_cwd',
      '  unset BROWSER_VIEWER_IN_PROMPT_COMMAND',
      '}',
      "trap '_browser_viewer_preexec' DEBUG",
    ].join("\n");
    const existingPromptCommand = env.PROMPT_COMMAND?.trim();
    return {
      ...env,
      BROWSER_VIEWER_LAST_COMMAND: "",
      PROMPT_COMMAND: existingPromptCommand
        ? `${emitBashHooks};_browser_viewer_precmd;${existingPromptCommand}`
        : `${emitBashHooks};_browser_viewer_precmd`,
    };
  }

  return env;
}
