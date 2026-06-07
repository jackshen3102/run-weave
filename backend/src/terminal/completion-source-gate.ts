import type { TerminalCompletionEvent } from "@browser-viewer/shared";

export const AI_COMPLETION_ACTIVE_COMMAND_GRACE_MS = 30_000;

const allowedActiveCommandsBySource: Partial<
  Record<TerminalCompletionEvent["source"], ReadonlySet<string>>
> = {
  codex: new Set(["codex"]),
  trae: new Set(["trae", "traex", "traecli"]),
};

export interface LastAiActiveCommandRecord {
  command: string;
  source: TerminalCompletionEvent["source"];
  observedAt: number;
  clearedAt: number | null;
}

function normalizeCommand(command: string | null): string | null {
  const normalized = command?.trim();
  return normalized || null;
}

export function getCompletionSourceForCommand(
  command: string | null,
): TerminalCompletionEvent["source"] | null {
  const normalized = normalizeCommand(command);
  if (!normalized) {
    return null;
  }

  for (const [source, commands] of Object.entries(
    allowedActiveCommandsBySource,
  )) {
    if (commands.has(normalized)) {
      return source as TerminalCompletionEvent["source"];
    }
  }
  return null;
}

export function isCompletionSourceAllowedForCommand(
  source: TerminalCompletionEvent["source"],
  command: string | null,
): boolean {
  const normalized = normalizeCommand(command);
  if (!normalized) {
    return false;
  }
  return allowedActiveCommandsBySource[source]?.has(normalized) ?? false;
}
