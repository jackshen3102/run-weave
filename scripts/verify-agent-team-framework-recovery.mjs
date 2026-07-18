import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentTeamPanelError } from "../backend/src/agent-team/service-run-policy.ts";
import { TerminalPanelError } from "../backend/src/terminal/application/panel-common.ts";
import { LowDbTerminalSessionStore } from "../backend/src/terminal/lowdb-store.ts";
import { TerminalSessionManager } from "../backend/src/terminal/manager.ts";
import {
  CONTINUE_REPAIR_KEY,
  check,
  checks,
  createFixture,
  createService,
  expectConflict,
  installFailedRerunRollbackHarness,
  installSuccessfulRerunHarness,
  verifySuccessorPersistenceRollback,
} from "./verify-agent-team-framework-recovery-support.mjs";

async function main() {
  await verifySuccessorPersistenceRollback();
  const root = await mkdtemp(
    path.join(os.tmpdir(), "runweave-framework-recovery-"),
  );
  const manager = new TerminalSessionManager(
    new LowDbTerminalSessionStore(path.join(root, "terminal-sessions.json")),
  );
  await manager.initialize();
  const beforeRestart = createService(manager, root, "backend-boot-a");
  const afterRestart = createService(manager, root, "backend-boot-b");
  try {
    const partialPanel = {
      panelId: "partial-panel",
      tmuxPaneId: "%99",
    };
    const sourcePanelError = new TerminalPanelError(500, "partial cleanup", {
      partialPanel,
    });
    const wrappedPanelError = createAgentTeamPanelError(
      "atr-review-harness",
      "code",
      sourcePanelError,
    );
    check(
      "ATFR-007-partial-panel-identity-survives-agent-team-wrapping",
      JSON.stringify(wrappedPanelError.details?.partialPanel) ===
        JSON.stringify(partialPanel),
      { source: sourcePanelError.details, wrapped: wrappedPanelError.details },
    );

    const fixture = await createFixture(manager, root, beforeRestart);
    const trustedAcceptance = structuredClone(fixture.run.acceptance);
    const trustedLoop = structuredClone(fixture.run.loop);
    const trustedReceipts = structuredClone(
      fixture.run.consumedWorkerDispatches,
    );
    const begun = await beforeRestart.beginFrameworkRepair(fixture.run.runId, {
      reason: "framework dispatch recovery",
    });
    check(
      "ATFR-001-begin-revokes-old-dispatch-and-preserves-history",
      begun.run.status === "need_human" &&
        begun.run.activeWorkerRole === null &&
        begun.run.activeWorkerDispatch === null &&
        begun.run.frameworkRepair?.target.invalidatedDispatch.dispatchId ===
          fixture.run.activeWorkerDispatch.dispatchId &&
        JSON.stringify(begun.run.acceptance) ===
          JSON.stringify(trustedAcceptance) &&
        JSON.stringify(begun.run.loop) === JSON.stringify(trustedLoop) &&
        JSON.stringify(begun.run.consumedWorkerDispatches) ===
          JSON.stringify(trustedReceipts) &&
        manager.getPanel(fixture.panelId)?.status === "running",
      begun.run,
    );
    const repeated = await beforeRestart.beginFrameworkRepair(
      fixture.run.runId,
      { reason: "ignored duplicate" },
    );
    check(
      "ATFR-002-repeat-begin-is-idempotent",
      repeated.run.frameworkRepair?.repairId ===
        begun.run.frameworkRepair?.repairId &&
        repeated.run.frameworkRepair?.begunAt ===
          begun.run.frameworkRepair?.begunAt &&
        repeated.run.updatedAt === begun.run.updatedAt,
      repeated.run.frameworkRepair,
    );
    const staleBefore = structuredClone(repeated.run);
    const staleConsumed = await beforeRestart.reconcileCompletionSignal({
      projectId: fixture.project.id,
      terminalSessionId: fixture.session.id,
      panelId: fixture.panelId,
      tmuxPaneId: fixture.paneId,
      cwd: root,
      source: "startup",
    });
    const staleAfter = await beforeRestart.getRun(fixture.run.runId);
    check(
      "ATFR-001-008-stale-completion-and-startup-scan-cannot-advance",
      staleConsumed === false &&
        JSON.stringify(staleAfter) === JSON.stringify(staleBefore),
      { staleConsumed, staleAfter },
    );
    await expectConflict(
      () =>
        beforeRestart.resumeRun(fixture.run.runId, {
          note: "must not bypass framework gate",
        }),
      "只能选择继续原 Run 或重新运行",
    );

    const beforeRestartStatus = await beforeRestart.getFrameworkRepairRecovery(
      fixture.run.runId,
    );
    check(
      "ATFR-005-status-distinguishes-backend-not-restarted",
      beforeRestartStatus.backendRestarted === false &&
        beforeRestartStatus.canContinue === false &&
        beforeRestartStatus.continueBlocker?.code === "backend_not_restarted" &&
        beforeRestartStatus.actions.join(",") === "continue,rerun",
      beforeRestartStatus,
    );
    const afterRestartStatus = await afterRestart.getFrameworkRepairRecovery(
      fixture.run.runId,
    );
    check(
      "ATFR-003-restart-and-exact-pane-enable-continue",
      afterRestartStatus.backendRestarted === true &&
        afterRestartStatus.canContinue === true &&
        afterRestartStatus.continueBlocker === null,
      afterRestartStatus,
    );

    const beforeFailedDelivery = await afterRestart.getRun(fixture.run.runId);
    afterRestart.submitWorkerDispatchPrompt = async () => {
      throw new Error("fixture delivery failure");
    };
    await expectConflict(
      () => afterRestart.continueFrameworkRepair(fixture.run.runId),
      "继续原 Run 投递失败",
    );
    const afterFailedDelivery = await afterRestart.getRun(fixture.run.runId);
    check(
      "ATFR-004-delivery-failure-keeps-blocked-state-retryable",
      JSON.stringify(afterFailedDelivery) ===
        JSON.stringify(beforeFailedDelivery),
      afterFailedDelivery,
    );
    let deliveredPrompt = "";
    afterRestart.submitWorkerDispatchPrompt = async (
      _run,
      _session,
      _terminal,
      _worker,
      prompt,
    ) => {
      deliveredPrompt = prompt;
    };
    const continued = await afterRestart.continueFrameworkRepair(
      fixture.run.runId,
    );
    check(
      "ATFR-003-continue-keeps-run-and-trusted-history-with-new-dispatch",
      continued.run.runId === fixture.run.runId &&
        continued.run.status === "running" &&
        continued.run.frameworkRepair?.result === "continued" &&
        continued.run.activeWorkerDispatch?.dispatchId !==
          fixture.run.activeWorkerDispatch.dispatchId &&
        JSON.stringify(continued.run.activeWorkerDispatch?.repairKeys) ===
          JSON.stringify(fixture.run.activeWorkerDispatch.repairKeys) &&
        JSON.stringify(continued.run.acceptance) ===
          JSON.stringify(trustedAcceptance) &&
        JSON.stringify(continued.run.loop) === JSON.stringify(trustedLoop) &&
        deliveredPrompt.includes(fixture.run.task) &&
        deliveredPrompt.includes(fixture.run.acceptance[0].caseId) &&
        deliveredPrompt.includes(fixture.run.activeWorkerDispatch.dispatchId) &&
        deliveredPrompt.includes(
          continued.run.activeWorkerDispatch.dispatchId,
        ) &&
        deliveredPrompt.includes(
          `.runweave/outbox/${fixture.session.id}.panel-${fixture.panelId}.json`,
        ) &&
        deliveredPrompt.includes(CONTINUE_REPAIR_KEY) &&
        deliveredPrompt.includes("fixVerifications") &&
        deliveredPrompt.includes("$toolkit:reproduce-before-fix"),
      { run: continued.run, deliveredPrompt },
    );

    const persistenceFailureFixture = await createFixture(
      manager,
      root,
      beforeRestart,
    );
    await beforeRestart.beginFrameworkRepair(
      persistenceFailureFixture.run.runId,
      {
        reason: "continue persistence after delivery",
      },
    );
    let deliveryCount = 0;
    let deliveredDispatchId = null;
    afterRestart.submitWorkerDispatchPrompt = async (run) => {
      deliveryCount += 1;
      deliveredDispatchId = run.activeWorkerDispatch?.dispatchId ?? null;
    };
    const originalUpdateRun = afterRestart.updateRun.bind(afterRestart);
    let updateCount = 0;
    afterRestart.updateRun = async (...args) => {
      updateCount += 1;
      if (updateCount === 2) {
        throw new Error("fixture continue finalization failure");
      }
      return originalUpdateRun(...args);
    };
    await expectConflict(
      () =>
        afterRestart.continueFrameworkRepair(
          persistenceFailureFixture.run.runId,
        ),
      "fixture continue finalization failure",
    );
    const pendingContinue = await afterRestart.getRun(
      persistenceFailureFixture.run.runId,
    );
    await expectConflict(
      () =>
        afterRestart.continueFrameworkRepair(
          persistenceFailureFixture.run.runId,
        ),
      "禁止重复派发",
    );
    await expectConflict(
      () =>
        afterRestart.rerunFrameworkRepair(persistenceFailureFixture.run.runId),
      "禁止重新运行",
    );
    check(
      "ATFR-003-004-continue-persistence-before-dispatch-prevents-duplicate-delivery",
      deliveryCount === 1 &&
        deliveredDispatchId !== null &&
        pendingContinue?.frameworkRepair?.result === "blocked" &&
        pendingContinue.frameworkRepair.pendingContinueDispatchId ===
          deliveredDispatchId &&
        pendingContinue.activeWorkerDispatch?.dispatchId ===
          deliveredDispatchId,
      { pendingContinue, deliveryCount, deliveredDispatchId },
    );
    afterRestart.updateRun = originalUpdateRun;

    const unavailableFixture = await createFixture(
      manager,
      root,
      beforeRestart,
    );
    await beforeRestart.beginFrameworkRepair(unavailableFixture.run.runId, {
      reason: "pane availability",
    });
    await manager.markPanelExited(unavailableFixture.panelId, 0);
    const unavailableStatus = await afterRestart.getFrameworkRepairRecovery(
      unavailableFixture.run.runId,
    );
    check(
      "ATFR-005-missing-pane-is-a-distinct-blocker",
      unavailableStatus.backendRestarted === true &&
        unavailableStatus.canContinue === false &&
        unavailableStatus.continueBlocker?.code === "worker_pane_unavailable" &&
        unavailableStatus.actions.includes("rerun"),
      unavailableStatus,
    );
    await expectConflict(
      () => afterRestart.continueFrameworkRepair(unavailableFixture.run.runId),
      "目标 Worker pane 不可用",
    );

    const rerunFixture = await createFixture(manager, root, beforeRestart);
    await beforeRestart.beginFrameworkRepair(rerunFixture.run.runId, {
      reason: "clean rerun",
    });
    installSuccessfulRerunHarness(afterRestart);
    const rerun = await afterRestart.rerunFrameworkRepair(
      rerunFixture.run.runId,
    );
    check(
      "ATFR-006-rerun-creates-clean-bidirectionally-linked-run",
      rerun.run.status === "failed" &&
        rerun.run.frameworkRepair?.result === "rerun" &&
        rerun.run.successorRunId === rerun.successorRun?.runId &&
        rerun.successorRun?.runId !== rerunFixture.run.runId &&
        rerun.successorRun?.predecessorRunId === rerunFixture.run.runId &&
        rerun.successorRun?.task === rerunFixture.run.task &&
        JSON.stringify(rerun.successorRun?.verification) ===
          JSON.stringify(rerunFixture.run.verification) &&
        JSON.stringify(rerun.successorRun?.terminal) ===
          JSON.stringify(rerunFixture.run.terminal) &&
        JSON.stringify(rerun.successorRun?.options) ===
          JSON.stringify(rerunFixture.run.options) &&
        rerun.successorRun?.acceptance.every(
          (item) =>
            item.status === "pending" &&
            item.evidence.length === 0 &&
            item.resultSummary === null,
        ) &&
        rerun.successorRun?.loop.round === 1 &&
        rerun.successorRun?.loop.repairCycles.length === 0 &&
        rerun.successorRun?.consumedWorkerDispatches?.length === 0 &&
        rerun.successorRun?.frameworkRepair === null &&
        rerun.successorRun?.activeWorkerDispatch?.dispatchId !==
          rerunFixture.run.activeWorkerDispatch.dispatchId,
      rerun,
    );
    const selectedRun = await afterRestart.getRunByTerminalSession(
      rerunFixture.project.id,
      rerunFixture.session.id,
    );
    check(
      "ATFR-006-terminal-session-selects-active-successor",
      selectedRun?.runId === rerun.successorRun?.runId &&
        selectedRun?.predecessorRunId === rerunFixture.run.runId,
      { selectedRun, predecessor: rerun.run, successor: rerun.successorRun },
    );

    const failedRerunFixture = await createFixture(
      manager,
      root,
      beforeRestart,
      { reviewCheckpointMode: "local_commit" },
    );
    await beforeRestart.beginFrameworkRepair(failedRerunFixture.run.runId, {
      reason: "rerun retry",
    });
    const failedRerunBefore = await afterRestart.getRun(
      failedRerunFixture.run.runId,
    );
    const rollbackCalls = installFailedRerunRollbackHarness(afterRestart, root);
    await expectConflict(
      () => afterRestart.rerunFrameworkRepair(failedRerunFixture.run.runId),
      "fixture split failure",
    );
    const failedRerunAfter = await afterRestart.getRun(
      failedRerunFixture.run.runId,
    );
    check(
      "ATFR-007-rerun-failure-leaves-old-run-untouched",
      JSON.stringify(failedRerunAfter) === JSON.stringify(failedRerunBefore) &&
        rollbackCalls.length === 1 &&
        rollbackCalls[0].originalBranch === "fixture-original" &&
        rollbackCalls[0].branch.startsWith("runweave/atr_"),
      { failedRerunAfter, rollbackCalls },
    );
    installSuccessfulRerunHarness(afterRestart);
    const retriedRerun = await afterRestart.rerunFrameworkRepair(
      failedRerunFixture.run.runId,
    );
    check(
      "ATFR-007-rerun-can-retry-after-input-recovers",
      retriedRerun.run.frameworkRepair?.result === "rerun" &&
        Boolean(retriedRerun.successorRun?.runId),
      retriedRerun,
    );

    const finalizationFixture = await createFixture(
      manager,
      root,
      beforeRestart,
    );
    await beforeRestart.beginFrameworkRepair(finalizationFixture.run.runId, {
      reason: "predecessor finalization rollback",
    });
    const finalizationBefore = await afterRestart.getRun(
      finalizationFixture.run.runId,
    );
    installSuccessfulRerunHarness(afterRestart);
    const writeRun = afterRestart.runStore.writeRun.bind(afterRestart.runStore);
    let persistedSuccessorId = null;
    afterRestart.runStore.writeRun = async (candidate) => {
      if (
        candidate.runId === finalizationFixture.run.runId &&
        candidate.frameworkRepair?.result === "rerun"
      ) {
        throw new Error("fixture predecessor finalization failure");
      }
      if (candidate.predecessorRunId === finalizationFixture.run.runId) {
        persistedSuccessorId = candidate.runId;
      }
      await writeRun(candidate);
    };
    await expectConflict(
      () => afterRestart.rerunFrameworkRepair(finalizationFixture.run.runId),
      "fixture predecessor finalization failure",
    );
    afterRestart.runStore.writeRun = writeRun;
    const finalizationAfter = await afterRestart.getRun(
      finalizationFixture.run.runId,
    );
    check(
      "ATFR-007-predecessor-finalization-failure-rolls-back-successor",
      JSON.stringify(finalizationAfter) ===
        JSON.stringify(finalizationBefore) &&
        persistedSuccessorId !== null &&
        (await afterRestart.getRun(persistedSuccessorId)) === null,
      { finalizationAfter, persistedSuccessorId },
    );

    const ordinaryFixture = await createFixture(manager, root, beforeRestart, {
      status: "need_human",
    });
    afterRestart.dispatchSerialWorker = async function dispatchSerialWorker(
      run,
      role,
    ) {
      const next = {
        ...run,
        status: "running",
        activeWorkerRole: role,
        updatedAt: new Date().toISOString(),
      };
      await this.runStore.writeRun(next);
      return next;
    };
    const ordinaryResumed = await afterRestart.resumeRun(
      ordinaryFixture.run.runId,
      { note: "ordinary resume remains available" },
    );
    check(
      "ATFR-010-ordinary-run-keeps-existing-resume-behavior",
      ordinaryResumed.status === "running" &&
        ordinaryResumed.frameworkRepair === undefined,
      ordinaryResumed,
    );

    process.stdout.write(
      `${JSON.stringify({ status: "passed", checks }, null, 2)}\n`,
    );
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

await main();
