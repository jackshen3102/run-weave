const ANSI_ESCAPE_SEQUENCE_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  "g",
);

const CODEX_TRUST_PROMPT_PATTERN =
  /Do you trust\s+the\s+contents\s+of\s+this\s+directory\?/i;
const CODEX_READY_PATTERN =
  /OpenAI Codex|(?:^|\n)\s*(?:gpt-[\w.-]+|codex-[\w.-]+|o\d(?:-[\w.-]+)?)\s+(?:low|medium|high|xhigh)\b/m;
const CODEX_UPDATE_PROMPT_PATTERN =
  /Update available![\s\S]{0,800}1\.\s+Update now[\s\S]{0,800}2\.\s+Skip[\s\S]{0,800}Press enter to continue/;
const CODEX_RESTART_AFTER_UPDATE_PATTERN =
  /Update ran successfully![\s\S]{0,160}Please restart Codex\./;
const TRAE_STARTUP_BANNER_PATTERN = /TRAE CLI Next/i;
const TRAE_READY_METADATA_PATTERN =
  /\bmodel:[^\S\n]*\S[^\n]*[\s\S]{0,1000}\bdirectory:[^\S\n]*\S[^\n]*[\s\S]{0,1000}\bpermissions:[^\S\n]*\S[^\n]*/i;
const TRAE_READY_INPUT_PROMPT_PATTERN = /❯/;
const TRAE_INTERACTIVE_PROMPT_PATTERN =
  /Do you trust\s+the\s+contents\s+of\s+this\s+directory\?|Press enter to continue|Select an option/i;
const TRAE_STARTUP_FAILURE_PATTERN =
  /(?:^|\n)\s*(?:zsh|bash|sh|fish):[^\n]*(?:command not found|not found)|(?:^|\n)\s*(?:error: unexpected argument|Usage: traecli\b)/im;

export function stripTerminalControlSequences(value: string): string {
  return value.replace(ANSI_ESCAPE_SEQUENCE_PATTERN, "").replace(/\r/g, "");
}

export function hasCodexReadyPrompt(scrollback: string): boolean {
  return CODEX_READY_PATTERN.test(stripTerminalControlSequences(scrollback));
}

export function hasPendingCodexTrustPrompt(scrollback: string): boolean {
  const cleanScrollback = stripTerminalControlSequences(scrollback);
  const trustPromptIndex = findLastIndex(
    cleanScrollback,
    CODEX_TRUST_PROMPT_PATTERN,
  );
  if (trustPromptIndex < 0) {
    return false;
  }
  const readyIndex = findLastIndex(cleanScrollback, CODEX_READY_PATTERN);
  return readyIndex < trustPromptIndex;
}

export function hasPendingCodexUpdatePrompt(scrollback: string): boolean {
  const cleanScrollback = stripTerminalControlSequences(scrollback);
  const updatePromptIndex = findLastIndex(
    cleanScrollback,
    CODEX_UPDATE_PROMPT_PATTERN,
  );
  if (updatePromptIndex < 0) {
    return false;
  }
  const readyIndex = findLastIndex(cleanScrollback, CODEX_READY_PATTERN);
  return readyIndex < updatePromptIndex;
}

export function hasCodexRestartRequiredAfterUpdate(
  scrollback: string,
): boolean {
  const cleanScrollback = stripTerminalControlSequences(scrollback);
  const restartPromptIndex = findLastIndex(
    cleanScrollback,
    CODEX_RESTART_AFTER_UPDATE_PATTERN,
  );
  if (restartPromptIndex < 0) {
    return false;
  }
  const readyIndex = findLastIndex(cleanScrollback, CODEX_READY_PATTERN);
  return readyIndex < restartPromptIndex;
}

export function hasStartedCodexUi(scrollback: string): boolean {
  const cleanScrollback = stripTerminalControlSequences(scrollback);
  const readyIndex = findLastIndex(cleanScrollback, CODEX_READY_PATTERN);
  if (readyIndex < 0) {
    return false;
  }
  const trustPromptIndex = findLastIndex(
    cleanScrollback,
    CODEX_TRUST_PROMPT_PATTERN,
  );
  return readyIndex > trustPromptIndex;
}

export function hasTraeReadyPrompt(scrollback: string): boolean {
  const cleanScrollback = stripTerminalControlSequences(scrollback);
  return resolveTraeTerminalUiState(cleanScrollback) === "ready";
}

export function hasTraeStartupFailure(scrollback: string): boolean {
  const cleanScrollback = stripTerminalControlSequences(scrollback);
  return resolveTraeTerminalUiState(cleanScrollback) === "startup_failure";
}

function resolveTraeTerminalUiState(
  cleanScrollback: string,
): "starting" | "ready" | "interactive" | "startup_failure" {
  const bannerIndex = findLastIndex(
    cleanScrollback,
    TRAE_STARTUP_BANNER_PATTERN,
  );
  const startupEpoch =
    bannerIndex >= 0 ? cleanScrollback.slice(bannerIndex) : cleanScrollback;
  const readyIndex =
    bannerIndex >= 0 ? findTraeReadyEndIndex(startupEpoch) : -1;
  const interactiveIndex = findLastEndIndex(
    startupEpoch,
    TRAE_INTERACTIVE_PROMPT_PATTERN,
  );
  const failureIndex = findLastEndIndex(
    startupEpoch,
    TRAE_STARTUP_FAILURE_PATTERN,
  );
  const latestIndex = Math.max(readyIndex, interactiveIndex, failureIndex);
  if (latestIndex < 0) {
    return "starting";
  }
  if (failureIndex === latestIndex) {
    return "startup_failure";
  }
  if (interactiveIndex === latestIndex) {
    return "interactive";
  }
  return "ready";
}

function findTraeReadyEndIndex(startupEpoch: string): number {
  const metadataEndIndex = findLastEndIndex(
    startupEpoch,
    TRAE_READY_METADATA_PATTERN,
  );
  if (metadataEndIndex < 0) {
    return -1;
  }
  const promptEndIndex = findLastEndIndex(
    startupEpoch.slice(metadataEndIndex),
    TRAE_READY_INPUT_PROMPT_PATTERN,
  );
  return promptEndIndex < 0
    ? -1
    : metadataEndIndex + promptEndIndex;
}

function findLastIndex(value: string, pattern: RegExp): number {
  let latest = -1;
  const globalPattern = new RegExp(pattern.source, `${pattern.flags}g`);
  for (const match of value.matchAll(globalPattern)) {
    latest = match.index ?? latest;
  }
  return latest;
}

function findLastEndIndex(value: string, pattern: RegExp): number {
  let latest = -1;
  const globalPattern = new RegExp(pattern.source, `${pattern.flags}g`);
  for (const match of value.matchAll(globalPattern)) {
    latest = (match.index ?? 0) + match[0].length;
  }
  return latest;
}
