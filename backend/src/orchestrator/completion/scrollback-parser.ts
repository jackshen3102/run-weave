const ANSI_ESCAPE_SEQUENCE_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  "g",
);

export interface WorkerPromptContext {
  runId: string | null;
  role: string | null;
  goalId: string | null;
  markerIndex: number;
}

export function extractWorkerPromptContext(scrollback: string): WorkerPromptContext {
  const clean = stripTerminalControlSequences(scrollback);
  const runMatch = findLastLineMatch(clean, /^\s*(?:[›>]\s*)?Run:\s*(\S+)\s*$/gm);
  return {
    runId: runMatch?.value ?? null,
    role: findLastLineMatch(clean, /^\s*(?:[›>]\s*)?Role:\s*(\S+)\s*$/gm)?.value ?? null,
    goalId: findLastLineMatch(clean, /^\s*(?:[›>]\s*)?Goal:\s*(.+?)\s*$/gm)?.value ?? null,
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
    .replace(ANSI_ESCAPE_SEQUENCE_PATTERN, "")
    .replace(/\r/g, "");
}
