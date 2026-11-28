import type { TerminalAgentKind } from "./runtime/state";

export const HANDOFF_BUDGET_BYTES = 49_152;
export const HANDOFF_PROMPT_BYTES = 32_768;
export const HANDOFF_MAX_PLAN_FILES = 5;
export const HANDOFF_PLACEMENTS = ["new_terminal", "in_place"] as const;
export type HandoffPlacement = (typeof HANDOFF_PLACEMENTS)[number];
export const HANDOFF_CONTEXT_SCOPES = [
  "full_conversation",
  "plan_focused",
] as const;
export type HandoffContextScope = (typeof HANDOFF_CONTEXT_SCOPES)[number];
export const HANDOFF_TARGET_AGENTS = [
  "codex",
  "claude",
  "pi",
  "traex",
  "agy",
] as const;
export type HandoffTargetAgent = (typeof HANDOFF_TARGET_AGENTS)[number];

export interface HandoffPlanFileCandidate {
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
  source: "mentioned" | "recent_plan";
}

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
  sourceProvider: TerminalAgentKind;
  sourceThreadId: string;
  sourceRevision: string;
  sourceProjectId: string;
  targetProjects: { projectId: string; name: string }[];
  canNativeCodexFork: boolean;
  canInPlaceHandoff: boolean;
  inPlaceUnavailableReason: string | null;
  detectedPlanFiles: HandoffPlanFileCandidate[];
}

export interface CreateTerminalContextHandoffRequest {
  operationId: string;
  panelId: string;
  expectedThreadId: string;
  expectedSourceRevision: string;
  targetAgent: HandoffTargetAgent;
  targetProjectId: string;
  mode: "native_fork" | "portable_handoff";
  placement?: HandoffPlacement;
  contextScope?: HandoffContextScope;
  planFilePaths?: string[];
  prompt: string;
  submitPrompt: boolean;
}

export interface CreateTerminalContextHandoffResponse {
  terminalSessionId: string;
  panelId: string;
  projectId: string;
  targetAgent: HandoffTargetAgent;
  mode: CreateTerminalContextHandoffRequest["mode"];
  placement: HandoffPlacement;
  handoffFilePath: string | null;
  status: "starting" | "delivered";
}
