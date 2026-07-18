import { createInitialLoop } from "../../backend/src/agent-team/loop.ts";

export function buildRun({
  runId,
  projectId,
  terminalSessionId,
  status = "running",
  runKind = "primary",
  lineage = null,
}) {
  const now = new Date().toISOString();
  return {
    runId,
    projectId,
    runKind,
    lineage,
    terminalSessionId,
    mainPanelId: null,
    phase: "executing",
    status,
    options: {
      autoApproveSplit: true,
      notifyMainOnHumanGate: true,
      reviewCheckpointMode: "disabled",
      maxRepairAttempts: 3,
      flow: "verify_first",
    },
    terminal: { command: "codex", args: [] },
    task: `${runId} fixture task`,
    verification: null,
    reviewCheckpoint: null,
    activeWorkerRole: null,
    activeWorkerDispatch: null,
    workerDispatchProtocolVersion: 1,
    consumedWorkerDispatches: [],
    clarify: [],
    proposal: null,
    workers: [],
    acceptance: [],
    loop: createInitialLoop(3, 1),
    humanNotes: [],
    findingDecisions: [],
    pendingFindingDecision: null,
    cancellation: null,
    fixtureResourceCleanup: null,
    fixtureCleanupHistory: [],
    logs: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function buildRuntimeRepairRun(owner) {
  const repairOwner = structuredClone(owner);
  repairOwner.runId = "atr_fixture_scope_repair_owner";
  repairOwner.activeWorkerRole = "code";
  repairOwner.activeWorkerDispatch = {
    dispatchId: "dispatch-runtime-repair",
    role: "code",
    panelId: "code-panel",
    tmuxPaneId: "%1",
    round: 2,
    requestedAt: new Date().toISOString(),
    outboxMtimeMs: null,
    repairKeys: ["behavior_verify:ATFR-020"],
  };
  repairOwner.loop.repairCycles = [
    {
      repairKey: "behavior_verify:ATFR-020",
      sourceRole: "behavior_verify",
      caseIds: ["ATFR-020"],
      invariant: "runtime fixture handoff",
      verificationMode: "runtime",
      sourceEvidenceRefs: ["fixture:before"],
      sourceReproduction: {
        mode: "real_product",
        status: "reproduced",
        scenarioId: "ATFR-020-runtime-repair",
        validationSessionId: "dvs-runtime-repair",
        steps: ["reproduce"],
        expected: "pass",
        actual: "fail",
        evidence: [
          {
            type: "log",
            label: "before",
            summary: "fail",
            ref: "fixture:before",
          },
        ],
      },
      attempts: 0,
      maxAttempts: 3,
      firstFailedRound: 1,
      lastFailedRound: 1,
      lastFailureSummary: "runtime failure",
    },
  ];
  return repairOwner;
}

export function lineage(owner, dispatchId, sessionId, ownsTerminalSession) {
  return {
    ownerRunId: owner.runId,
    ownerDispatchId: dispatchId,
    ownerCaseIds: ["ATFR-020"],
    ownerDevSessionId: sessionId,
    fixtureNamespace: `agent-team:${owner.runId}:${dispatchId}:${sessionId}`,
    ownsTerminalSession,
    cleanupPolicy: "on_owner_dispatch_complete",
  };
}
