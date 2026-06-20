import { randomBytes } from "node:crypto";
import type {
  OrchestratorGoal,
  OrchestratorRunPackage,
  OrchestratorTimelineItem,
} from "@runweave/shared";
import type { CreateRunInput } from "../types";
import { assertSafeOrchestratorRunId } from "../run-id";
import { INITIAL_DO_A_IDEM_PHASE } from "../workflow/do-a-idem";

export function createRunId(now = new Date().toISOString()): string {
  return `run_${now.replace(/\D/g, "").slice(0, 14)}_${randomBytes(3).toString("hex")}`;
}

export function createTimelineItem(
  input: Omit<OrchestratorTimelineItem, "id" | "at">,
): OrchestratorTimelineItem {
  return {
    id: `evt_${Date.now()}_${randomBytes(2).toString("hex")}`,
    at: new Date().toISOString(),
    ...input,
  };
}

export function upsertGoal(
  goals: OrchestratorGoal[],
  nextGoal: OrchestratorGoal,
): OrchestratorGoal {
  const existing = goals.find((goal) => goal.id === nextGoal.id);
  if (!existing) {
    goals.push(nextGoal);
    return nextGoal;
  }
  Object.assign(existing, nextGoal);
  return existing;
}

export function buildRunPackage(params: {
  input: CreateRunInput;
  runId: string;
  orchestratorSessionId: string | null;
  now: string;
  timelineItem?: (input: {
    type: OrchestratorTimelineItem["type"];
    title: string;
    detail?: string;
    terminalSessionId?: string | null;
  }) => OrchestratorTimelineItem;
}): OrchestratorRunPackage {
  assertSafeOrchestratorRunId(params.runId);
  const timelineItem =
    params.timelineItem ??
    ((input) => ({
      id: "preview_run_created",
      type: input.type,
      title: input.title,
      detail: input.detail,
      terminalSessionId: input.terminalSessionId,
      at: params.now,
    }));
  return {
    runId: params.runId,
    projectId: params.input.projectId,
    task: params.input.task,
    status: "running",
    currentPhase: INITIAL_DO_A_IDEM_PHASE,
    options: {
      requireHumanConfirmationEachRound: Boolean(
        params.input.options?.requireHumanConfirmationEachRound,
      ),
      autoApprovePlanGate: Boolean(params.input.options?.autoApprovePlanGate),
      autoApproveVerifyGate: Boolean(params.input.options?.autoApproveVerifyGate),
    },
    pendingRoundConfirmation: null,
    orchestrator: {
      role: "orchestrator",
      binding: params.input.orchestrator.binding,
      sessionId: params.orchestratorSessionId,
      startupPrompt: params.input.orchestrator.startupPrompt,
      terminal: params.input.orchestrator.terminal,
    },
    roles: params.input.roles,
    goals: [],
    humanInbox: [],
    humanGateVerdicts: [],
    roundConfirmations: [],
    timeline: [
      timelineItem({
        type: "run_created",
        title: "Run created",
        detail: params.input.task,
        terminalSessionId: params.orchestratorSessionId,
      }),
    ],
    createdAt: params.now,
    updatedAt: params.now,
  };
}
