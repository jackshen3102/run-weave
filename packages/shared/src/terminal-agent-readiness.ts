const ANSI_ESCAPE_SEQUENCE_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  "g",
);

const CODEX_TRUST_PROMPT_PATTERN =
  /Do you trust the contents of this directory\?|Press enter to continue/;
const CODEX_READY_PATTERN =
  /OpenAI Codex|(?:^|\n)\s*(?:gpt-[\w.-]+|codex-[\w.-]+|o\d(?:-[\w.-]+)?)\s+(?:low|medium|high)\b|(?:^|\n)\s*›\s/m;

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
