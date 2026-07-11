import type { TerminalCompletionEvent } from "@runweave/shared/terminal/completion";

export const AI_COMPLETION_ACTIVE_COMMAND_GRACE_MS = 30_000;

const allowedActiveCommandsBySource: Partial<
  Record<TerminalCompletionEvent["source"], ReadonlySet<string>>
> = {
  codex: new Set(["codex"]),
  trae: new Set(["trae"]),
  traecli: new Set(["traecli"]),
  traex: new Set(["traex"]),
};

const legacyAllowedActiveCommandsBySource: Partial<
  Record<TerminalCompletionEvent["source"], ReadonlySet<string>>
> = {
  trae: new Set(["traex", "traecli"]),
};

export interface LastAiActiveCommandRecord {
  command: string;
  source: TerminalCompletionEvent["source"];
  observedAt: number;
  clearedAt: number | null;
}

function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const character of command) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }
    if (character === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }

  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function isEnvironmentAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

export function getExecutableCommandName(command: string | null): string | null {
  const normalized = command?.trim();
  if (!normalized) {
    return null;
  }

  const tokens = tokenizeShellCommand(normalized.replace(/\\+/g, "/"));
  let index = 0;
  if (tokens[index] === "env") {
    index += 1;
    while (tokens[index]?.startsWith("-")) {
      index += 1;
    }
  }
  while (tokens[index] && isEnvironmentAssignment(tokens[index]!)) {
    index += 1;
  }

  const executable = tokens[index];
  if (!executable) {
    return null;
  }
  return executable.split("/").filter(Boolean).at(-1) ?? executable;
}

export function getCompletionSourceForCommand(
  command: string | null,
): TerminalCompletionEvent["source"] | null {
  const normalized = getExecutableCommandName(command);
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
  const normalized = getExecutableCommandName(command);
  if (!normalized) {
    return false;
  }
  return (
    allowedActiveCommandsBySource[source]?.has(normalized) ||
    legacyAllowedActiveCommandsBySource[source]?.has(normalized) ||
    false
  );
}
