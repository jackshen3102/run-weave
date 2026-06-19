import type { AgentCliCommand } from "./types";
import { DEFAULT_STARTUP_PROMPT, LEGACY_STARTUP_PROMPT } from "./constants";

export function normalizeAgentCliCommand(value: string | undefined): AgentCliCommand {
  return value === "traex" ? "traex" : "codex";
}

export function normalizeStartupPrompt(value: string): string {
  const trimmed = value.trim();
  if (trimmed === LEGACY_STARTUP_PROMPT) {
    return DEFAULT_STARTUP_PROMPT;
  }
  if (trimmed.startsWith(LEGACY_STARTUP_PROMPT)) {
    return `${DEFAULT_STARTUP_PROMPT}${trimmed.slice(LEGACY_STARTUP_PROMPT.length)}`;
  }
  return value;
}
