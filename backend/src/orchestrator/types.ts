import type {
  OrchestratorRoleDefinition,
  OrchestratorRunRole,
  TerminalAgentKind,
  TerminalState,
} from "@runweave/shared";

export interface CreateRunInput {
  runId?: string;
  projectId: string;
  task: string;
  orchestrator: {
    binding: { mode: "new" | "reuse"; sessionId?: string | null };
    startupPrompt: string;
    terminal: OrchestratorRoleDefinition["terminal"];
  };
  roles: OrchestratorRunRole[];
  options?: {
    requireHumanConfirmationEachRound?: boolean;
  };
}

export interface DispatchInput {
  runId: string;
  roleId: string;
  goalId: string;
  query: string;
  desc?: string;
  sessionId?: string | null;
  newSession?: boolean;
}

export interface AgentSnapshot {
  activeCommand: string | null;
  currentAgent: TerminalAgentKind | null;
  terminalState: TerminalState;
}
