import type {
  DoAIdemPhase,
  HumanGatePhase,
  HumanGateVerdictValue,
  OrchestratorPendingRoundConfirmation,
  OrchestratorRunPackage,
  OrchestratorRunStatus,
  OrchestratorWorkerOutbox,
} from "@runweave/shared";

export const INITIAL_DO_A_IDEM_PHASE: DoAIdemPhase = "plan";

export function advancePhaseForDispatch(
  roleId: string,
): DoAIdemPhase | null {
  if (roleId === "plan_reviewer") {
    return "plan_review";
  }
  if (roleId === "code_agent") {
    return "code";
  }
  if (roleId === "code_reviewer") {
    return "code_review";
  }
  return null;
}

export function advancePhaseForWorkerResult(
  outbox: OrchestratorWorkerOutbox,
): { currentPhase: DoAIdemPhase; status?: OrchestratorRunStatus } | null {
  if (outbox.status !== "completed") {
    return null;
  }
  if (outbox.role === "plan_reviewer") {
    return { currentPhase: "human_plan_approval", status: "need_human" };
  }
  if (outbox.role === "code_agent") {
    return { currentPhase: "code_review" };
  }
  if (outbox.role === "code_reviewer") {
    return { currentPhase: "human_verify", status: "need_human" };
  }
  return null;
}

export function shouldRequireRoundConfirmation(params: {
  run: OrchestratorRunPackage;
  nextPhase: DoAIdemPhase;
  nextStatus?: OrchestratorRunStatus;
}): boolean {
  return (
    Boolean(params.run.options?.requireHumanConfirmationEachRound) &&
    params.nextStatus !== "need_human" &&
    params.run.currentPhase !== params.nextPhase
  );
}

export function createPendingRoundConfirmation(params: {
  id: string;
  at: string;
  run: OrchestratorRunPackage;
  nextPhase: DoAIdemPhase;
  outbox: OrchestratorWorkerOutbox;
}): OrchestratorPendingRoundConfirmation {
  return {
    id: params.id,
    at: params.at,
    fromPhase: params.run.currentPhase ?? INITIAL_DO_A_IDEM_PHASE,
    nextPhase: params.nextPhase,
    roleId: params.outbox.role ?? null,
    goalId: params.outbox.goalId ?? null,
    summary: params.outbox.summary,
  };
}

export function resolveHumanGateTransition(input: {
  phase: HumanGatePhase;
  verdict: HumanGateVerdictValue;
}): { currentPhase: DoAIdemPhase; status: OrchestratorRunStatus } {
  if (input.phase === "human_plan_approval") {
    return {
      currentPhase: input.verdict === "approved" ? "code" : "plan",
      status: "running",
    };
  }
  return {
    currentPhase: input.verdict === "approved" ? "finalize" : "code",
    status: "running",
  };
}

export function canMarkDone(run: OrchestratorRunPackage): boolean {
  return run.currentPhase === "finalize";
}
