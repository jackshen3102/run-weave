import { rm, writeFile } from "node:fs/promises";

import { AGENT_TEAM_REVIEW_GATE_CASE_ID } from "../../backend/src/agent-team/service-acceptance-policy.ts";

export async function verifyReviewSkipPause({
  buildRun,
  check,
  harness,
  outboxPath,
  prompts,
  reviewWorker,
  service,
  writes,
}) {
  await rm(outboxPath, { force: true });
  const skippedRun = buildRun(harness).run;
  skippedRun.activeWorkerDispatch = {
    ...skippedRun.activeWorkerDispatch,
    dispatchId: "review-skipped-dispatch",
  };
  await service.runStore.writeRun(skippedRun);
  writes.length = 0;
  prompts.length = 0;
  await writeFile(
    outboxPath,
    `${JSON.stringify({
      sessionId: skippedRun.terminalSessionId,
      projectId: skippedRun.projectId,
      runId: skippedRun.runId,
      panelId: reviewWorker.panelId,
      tmuxPaneId: reviewWorker.tmuxPaneId,
      role: "code_review",
      dispatchId: "review-skipped-dispatch",
      status: "completed",
      summary: "review environment unavailable",
      findings: [],
      resolvedFindings: [],
      remainingFindings: [],
      acceptanceResults: [
        {
          caseId: AGENT_TEAM_REVIEW_GATE_CASE_ID,
          status: "skipped",
          summary: "review environment unavailable",
          skip: {
            code: "environment",
            retryable: true,
            detail: "review runtime unavailable",
          },
          evidence: [],
        },
      ],
      finishedAt: new Date().toISOString(),
    })}\n`,
  );
  const skippedReconciled = await service.reconcileCompletionSignal({
    projectId: skippedRun.projectId,
    terminalSessionId: skippedRun.terminalSessionId,
    panelId: reviewWorker.panelId,
    tmuxPaneId: reviewWorker.tmuxPaneId,
    cwd: harness.session.cwd,
    source: "app_server",
  });
  const skippedSnapshot = writes[0];
  check(
    "review-skip-pauses-instead-of-persisting-a-split-worker-boundary",
    skippedReconciled &&
      writes.length === 1 &&
      skippedSnapshot?.status === "need_human" &&
      skippedSnapshot.activeWorkerRole === null &&
      skippedSnapshot.activeWorkerDispatch === null &&
      skippedSnapshot.workers.every((worker) => worker.frozen) &&
      skippedSnapshot.loop.lastReason?.includes(
        "code_review completion 后没有合法下一动作",
      ) &&
      skippedSnapshot.consumedWorkerDispatches?.[0]?.dispatchId ===
        "review-skipped-dispatch" &&
      prompts.length === 0,
    { writes, prompts, skippedReconciled },
  );
}
