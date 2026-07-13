import { createInitialLoop } from "../../backend/src/agent-team/loop.ts";
import { normalizeAgentTeamWorkerOutbox } from "../../backend/src/agent-team/outbox-resolver.ts";

export function buildRepairEvidence(label) {
  return {
    type: "command",
    label,
    summary: `${label} evidence`,
    ref: `fixture:${label}`,
  };
}

export function buildRepairRun() {
  const now = "2026-07-14T00:00:00.000Z";
  return {
    runId: "atr_repair_fixture",
    projectId: "project",
    terminalSessionId: "repair-session",
    phase: "executing",
    status: "running",
    options: {
      autoApproveSplit: true,
      reviewCheckpointMode: "disabled",
      maxRepairAttempts: 3,
    },
    terminal: { command: "codex", args: [], cwd: null },
    task: "repair fixture",
    verification: null,
    reviewCheckpoint: null,
    activeWorkerRole: "code",
    activeWorkerDispatch: null,
    clarify: [],
    proposal: null,
    workers: [
      {
        id: "code-worker",
        role: "code",
        intent: "fix",
        panelId: "code-panel",
        tmuxPaneId: "%1",
        frozen: false,
      },
      {
        id: "review-worker",
        role: "code_review",
        intent: "review",
        panelId: "review-panel",
        tmuxPaneId: "%2",
        frozen: true,
      },
      {
        id: "behavior-worker",
        role: "behavior_verify",
        intent: "verify",
        panelId: "behavior-panel",
        tmuxPaneId: "%3",
        frozen: true,
      },
    ],
    acceptance: [
      {
        caseId: "CASE-RUNTIME-001",
        text: "真实 runtime invariant",
        status: "fail",
        consecutiveFail: 2,
        evidence: [buildRepairEvidence("runtime-fail")],
        bouncedToPanelId: "code-panel",
      },
      {
        caseId: "case_2",
        text: "Code Review 未发现阻断性问题（P0/P1）",
        status: "fail",
        consecutiveFail: 1,
        evidence: [buildRepairEvidence("review-fail")],
        bouncedToPanelId: "code-panel",
      },
    ],
    loop: createInitialLoop(3),
    humanNotes: [],
    logs: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function buildFixVerification(cycle, overrides = {}) {
  const runtime = cycle.verificationMode === "runtime";
  const structuralEvidence = (cycle.sourceEvidenceRefs ?? []).map((ref) => ({
    ...buildRepairEvidence("review-harness"),
    ref,
  }));
  return {
    repairKey: cycle.repairKey,
    invariant: cycle.invariant,
    reproduction: {
      mode: runtime ? "real_product" : "review_harness",
      status: runtime ? "reproduced" : "confirmed",
      ...(runtime
        ? {
            scenarioId: "repair-runtime",
            validationSessionId: "dvs-repair",
          }
        : {}),
      evidence: runtime
        ? [buildRepairEvidence("before")]
        : structuralEvidence.length > 0
          ? structuralEvidence
          : [buildRepairEvidence("before")],
    },
    verification: {
      status: "pass",
      sameScenario: true,
      evidence: runtime
        ? [buildRepairEvidence("after")]
        : structuralEvidence.length > 0
          ? structuralEvidence
          : [buildRepairEvidence("after")],
    },
    impactedChecks: [
      {
        label: "affected regression",
        dimension: "regression",
        status: "pass",
        summary: "affected regression passed",
        evidence: [buildRepairEvidence("regression")],
      },
    ],
    ...overrides,
  };
}

export function normalizeRepairOutbox(run, fixVerifications) {
  return normalizeAgentTeamWorkerOutbox({
    sessionId: run.terminalSessionId,
    panelId: "code-panel",
    tmuxPaneId: "%1",
    projectId: run.projectId,
    runId: run.runId,
    role: "code",
    status: "completed",
    summary: "repair complete",
    error: null,
    finishedAt: "2026-07-14T00:01:00.000Z",
    fixVerifications,
  });
}
