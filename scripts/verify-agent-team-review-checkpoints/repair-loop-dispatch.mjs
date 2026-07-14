import { normalizeAgentTeamWorkerOutbox } from "../../backend/src/agent-team/outbox-resolver.ts";
import { incrementRepairAttempts } from "../../backend/src/agent-team/repair-loop.ts";
import {
  completionOutboxIdentityMismatch,
  completionSignalWorkerMismatch,
  createActiveWorkerDispatch,
  resolveActiveWorkerDispatch,
  workerOutboxFreshnessMismatch,
} from "../../backend/src/agent-team/service-workflow-policy.ts";

export function verifyDispatchProtocolChecks(
  check,
  { run, runtimeRun, runtimeCycle, behaviorDispatchRun },
) {
  const currentBehaviorOutbox = normalizeAgentTeamWorkerOutbox({
    sessionId: behaviorDispatchRun.terminalSessionId,
    panelId: run.workers[2].panelId,
    tmuxPaneId: run.workers[2].tmuxPaneId,
    projectId: behaviorDispatchRun.projectId,
    runId: behaviorDispatchRun.runId,
    role: "behavior_verify",
    dispatchId: behaviorDispatchRun.activeWorkerDispatch.dispatchId,
    status: "completed",
    summary: "current behavior result",
    error: null,
    finishedAt: "2026-07-14T00:01:00.000Z",
  });
  const delayedStaleOutbox = normalizeAgentTeamWorkerOutbox({
    ...currentBehaviorOutbox,
    dispatchId: "dispatch-from-previous-round",
  });
  check(
    "repair-current-dispatch-outbox-accepted",
    completionOutboxIdentityMismatch(
      behaviorDispatchRun,
      run.workers[2],
      behaviorDispatchRun.activeWorkerDispatch,
      currentBehaviorOutbox,
      true,
    ) === null,
    currentBehaviorOutbox,
  );
  check(
    "repair-delayed-stale-outbox-rejected-even-when-fresh",
    workerOutboxFreshnessMismatch(
      behaviorDispatchRun.activeWorkerDispatch,
      2,
    ) === null &&
      completionOutboxIdentityMismatch(
        behaviorDispatchRun,
        run.workers[2],
        behaviorDispatchRun.activeWorkerDispatch,
        delayedStaleOutbox,
        true,
      ) === "outbox_dispatch_id_mismatch",
    delayedStaleOutbox,
  );
  const missingDispatchOutbox = normalizeAgentTeamWorkerOutbox({
    ...currentBehaviorOutbox,
    dispatchId: null,
  });
  check(
    "repair-new-dispatch-requires-outbox-dispatch-id",
    completionOutboxIdentityMismatch(
      behaviorDispatchRun,
      run.workers[2],
      behaviorDispatchRun.activeWorkerDispatch,
      missingDispatchOutbox,
      true,
    ) === "outbox_dispatch_id_missing",
    missingDispatchOutbox,
  );
  const legacyDispatch = {
    ...behaviorDispatchRun.activeWorkerDispatch,
    outboxDispatchIdRequired: undefined,
  };
  check(
    "repair-legacy-dispatch-allows-legacy-outbox",
    completionOutboxIdentityMismatch(
      { ...behaviorDispatchRun, activeWorkerDispatch: legacyDispatch },
      run.workers[2],
      legacyDispatch,
      missingDispatchOutbox,
      true,
    ) === null,
    legacyDispatch,
  );
  const recoveredDispatchId =
    behaviorDispatchRun.activeWorkerDispatch.dispatchId;
  const recoveredRun = {
    ...behaviorDispatchRun,
    activeWorkerDispatch: null,
    acceptance: [
      {
        ...run.acceptance[0],
        status: "pending",
        recheckRequestedAt: run.updatedAt,
        recheckDispatchId: recoveredDispatchId,
        recheckWorkerPanelId: run.workers[2].panelId,
        recheckWorkerRole: "behavior_verify",
        recheckOutboxMtimeMs: 1,
      },
    ],
  };
  const recoveredDispatch = resolveActiveWorkerDispatch(
    recoveredRun,
    run.workers[2],
  );
  check(
    "repair-recovered-dispatch-preserves-persisted-id",
    Boolean(recoveredDispatch) &&
      recoveredDispatch.dispatchId === recoveredDispatchId &&
      recoveredDispatch.outboxDispatchIdRequired === false,
    recoveredDispatch,
  );
  check(
    "repair-modern-run-never-synthesizes-legacy-dispatch",
    resolveActiveWorkerDispatch(
      {
        ...recoveredRun,
        workerDispatchProtocolVersion: 1,
        consumedWorkerDispatches: [],
      },
      run.workers[2],
    ) === null,
    recoveredRun,
  );
  check(
    "repair-stale-outbox-cannot-double-count",
    workerOutboxFreshnessMismatch(
      createActiveWorkerDispatch(
        run.workers[0],
        run.updatedAt,
        200,
        run.loop.round,
      ),
      200,
    ) === "outbox_not_newer_than_dispatch_baseline",
    "stale outbox accepted",
  );
  check(
    "repair-accepted-handoff-restart-state-is-idempotent",
    incrementRepairAttempts(runtimeRun.loop, [runtimeCycle.repairKey])
      .repairCycles[0]?.attempts === 1 &&
      completionSignalWorkerMismatch(
        {
          kind: "completion",
          payload: { panelId: "code-panel", tmuxPaneId: "%1" },
        },
        run.workers[1],
      ) === "signal_panel_mismatch",
    "a repeated code completion could match the persisted reviewer dispatch",
  );
  check(
    "repair-legacy-outbox-remains-readable",
    Boolean(
      normalizeAgentTeamWorkerOutbox({
        sessionId: "legacy",
        role: "code",
        status: "completed",
        summary: "legacy",
        error: null,
        finishedAt: "2026-07-14T00:00:00.000Z",
      }),
    ),
    "legacy outbox rejected",
  );
}
