import type {
  CreateTerminalSessionRequest,
  OrchestratorRoleDefinition,
} from "@runweave/shared";

export function normalizeTerminalRequest(
  terminal: OrchestratorRoleDefinition["terminal"],
): Omit<CreateTerminalSessionRequest, "projectId"> {
  return {
    command: terminal.command,
    args: terminal.args,
    cwd: terminal.cwd ?? undefined,
    runtimePreference: terminal.runtimePreference,
  };
}
