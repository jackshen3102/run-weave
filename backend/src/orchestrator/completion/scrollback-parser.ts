const ESCAPE_CHAR = String.fromCharCode(27);
const BELL_CHAR = String.fromCharCode(7);
const ANSI_ESCAPE_SEQUENCE_PATTERN = new RegExp(
  `${ESCAPE_CHAR}\\[[0-?]*[ -/]*[@-~]`,
  "g",
);
const OSC_ESCAPE_SEQUENCE_PATTERN = new RegExp(
  `${ESCAPE_CHAR}\\][^${BELL_CHAR}]*(?:${BELL_CHAR}|${ESCAPE_CHAR}\\\\)`,
  "g",
);
const OSC_TITLE_SEQUENCE_PATTERN = new RegExp(
  `\\]0;[^${BELL_CHAR}\\n]*(?:${BELL_CHAR}|$)`,
  "g",
);
const TERMINAL_CONTROL_CHARS_PATTERN = new RegExp(
  `[${BELL_CHAR}${ESCAPE_CHAR}]`,
  "g",
);

export interface WorkerPromptContext {
  runId: string | null;
  role: string | null;
  goalId: string | null;
  markerIndex: number;
}

export function extractWorkerPromptContext(
  scrollback: string,
): WorkerPromptContext {
  const clean = stripTerminalControlSequences(scrollback);
  const runMatch = findLastLineMatch(
    clean,
    /^\s*(?:[›>]\s*)?Run:\s*(\S+)\s*$/gm,
  );
  return {
    runId: runMatch?.value ?? null,
    role:
      findLastLineMatch(clean, /^\s*(?:[›>]\s*)?Role:\s*(\S+)\s*$/gm)?.value ??
      null,
    goalId:
      findLastLineMatch(clean, /^\s*(?:[›>]\s*)?Goal:\s*(.+?)\s*$/gm)?.value ??
      null,
    markerIndex: runMatch?.index ?? -1,
  };
}

export function extractWorkerSummaryFromScrollback(
  scrollback: string,
  context: WorkerPromptContext,
): string {
  const clean = stripTerminalControlSequences(scrollback).trim();
  const relevant =
    context.markerIndex >= 0 ? clean.slice(context.markerIndex).trim() : clean;
  const summary = relevant || clean;
  return summary.length > 8000
    ? `${summary.slice(-8000)}\n...[truncated terminal tail]`
    : summary;
}

function findLastLineMatch(
  value: string,
  pattern: RegExp,
): { value: string; index: number } | null {
  let latest: { value: string; index: number } | null = null;
  for (const match of value.matchAll(pattern)) {
    latest = { value: match[1]?.trim() ?? "", index: match.index ?? -1 };
  }
  return latest?.value ? latest : null;
}

function stripTerminalControlSequences(value: string): string {
  return value
    .replace(OSC_ESCAPE_SEQUENCE_PATTERN, "")
    .replace(OSC_TITLE_SEQUENCE_PATTERN, "")
    .replace(ANSI_ESCAPE_SEQUENCE_PATTERN, "")
    .replace(TERMINAL_CONTROL_CHARS_PATTERN, "")
    .replace(/\r/g, "");
}
