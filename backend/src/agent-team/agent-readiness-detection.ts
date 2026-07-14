import {
  hasStartedCodexUi,
  hasTraeReadyPrompt,
} from "@runweave/shared/terminal-agent-readiness";
import type { TerminalAgentKind } from "@runweave/shared/terminal/state";
import { getAgentForCommand } from "../terminal/terminal-state-service";

export function hasStartedAgentUi(
  agent: TerminalAgentKind,
  scrollback: string,
  traeStartupOutput?: string,
): boolean {
  if (agent === "codex") {
    return hasStartedCodexUi(scrollback);
  }
  return (
    hasTraeReadyPrompt(scrollback) &&
    (traeStartupOutput === undefined || hasTraeReadyPrompt(traeStartupOutput))
  );
}

export function hasMatchingAgentReadinessOwner(
  activeCommand: string | null,
  agent: TerminalAgentKind,
): boolean {
  const activeAgent = getAgentForCommand(activeCommand);
  return agent === "codex"
    ? activeAgent === "codex"
    : activeAgent !== null && activeAgent !== "codex";
}
