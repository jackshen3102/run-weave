import type { TerminalAgentKind } from "./runtime/state";

export const HANDOFF_BUDGET_BYTES = 49_152;
export const HANDOFF_PROMPT_BYTES = 32_768;
export const HANDOFF_TARGET_AGENTS = [
  "codex",
  "claude",
  "pi",
  "traex",
  "agy",
] as const;
export type HandoffTargetAgent = (typeof HANDOFF_TARGET_AGENTS)[number];

export interface HandoffCoverage {
  totalMessages: number;
  includedMessages: number;
  omittedMessages: number;
  includedTurns: number;
  omittedTurns: number;
  partialTurns: number;
  handoffBytes: number;
  budgetBytes: number;
}

export interface HandoffProjection {
  revision: string;
  document: string;
  coverage: HandoffCoverage;
}

export interface TerminalContextHandoffPreview extends HandoffCoverage {
  sourceTerminalId: string;
  sourcePanelId: string;
  sourceProvider: Exclude<TerminalAgentKind, "agy">;
  sourceThreadId: string;
  sourceRevision: string;
  sourceProjectId: string;
  targetProjects: { projectId: string; name: string }[];
  canNativeCodexFork: boolean;
}

export interface CreateTerminalContextHandoffRequest {
  operationId: string;
  panelId: string;
  expectedThreadId: string;
  expectedSourceRevision: string;
  targetAgent: HandoffTargetAgent;
  targetProjectId: string;
  mode: "native_fork" | "portable_handoff";
  prompt: string;
  submitPrompt: boolean;
}

export interface CreateTerminalContextHandoffResponse {
  terminalSessionId: string;
  panelId: string;
  projectId: string;
  targetAgent: HandoffTargetAgent;
  mode: CreateTerminalContextHandoffRequest["mode"];
  handoffFilePath: string | null;
  status: "starting" | "delivered";
}
