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
