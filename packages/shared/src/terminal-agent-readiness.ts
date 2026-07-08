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

export function hasCodexRestartRequiredAfterUpdate(scrollback: string): boolean {
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

function findLastIndex(value: string, pattern: RegExp): number {
  let latest = -1;
  const globalPattern = new RegExp(pattern.source, `${pattern.flags}g`);
  for (const match of value.matchAll(globalPattern)) {
    latest = match.index ?? latest;
  }
  return latest;
}
