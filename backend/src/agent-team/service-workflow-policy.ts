import { createHash, randomUUID } from "node:crypto";
import type {
  AgentTeamActiveWorkerDispatch,
  AgentTeamRun,
  AgentTeamWorker,
  AgentTeamWorkerOutbox,
  AgentTeamWorkerRole,
} from "@runweave/shared/agent-team";
import type { TerminalEventEnvelope } from "@runweave/shared/terminal/events";

const DEFAULT_EXPORT_TAIL_LINES = 1_000;
const MAX_EXPORT_TAIL_LINES = 5_000;
let workerCounter = 0;

export const VALID_WORKER_ROLES: AgentTeamWorkerRole[] = [
  "code",
  "code_review",
  "behavior_verify",
];
export const EXECUTION_WORKER_ORDER: AgentTeamWorkerRole[] = [
  "code",
  "code_review",
  "behavior_verify",
];

export function buildAgentTeamPanelRole(
  runId: string,
  role: AgentTeamWorkerRole,
): string {
  return `agent-team:${runId}:${role}`;
}

export function parseWorkerRole(
  role: string | null | undefined,
): AgentTeamWorkerRole | null {
  return VALID_WORKER_ROLES.includes(role as AgentTeamWorkerRole)
    ? (role as AgentTeamWorkerRole)
    : null;
}

export function parseWorkerRoleFromPanelRole(
  runId: string,
  role: string | null | undefined,
): AgentTeamWorkerRole | null {
  const prefix = `agent-team:${runId}:`;
  if (!role?.startsWith(prefix)) {
    return null;
  }
  return parseWorkerRole(role.slice(prefix.length));
}

export function clampExportTailLines(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined) {
    return DEFAULT_EXPORT_TAIL_LINES;
  }
  return Math.min(Math.max(Math.trunc(value), 1), MAX_EXPORT_TAIL_LINES);
}

export function resolveInitialActiveWorkerRole(
  workers: AgentTeamWorker[],
): AgentTeamWorkerRole | null {
  for (const role of EXECUTION_WORKER_ORDER) {
    if (workers.some((worker) => worker.role === role && worker.panelId)) {
      return role;
    }
  }
  return workers.find((worker) => worker.panelId)?.role ?? null;
}

export function findWorkerByRole(
  workers: AgentTeamWorker[],
  role: AgentTeamWorkerRole,
): AgentTeamWorker | null {
  return (
    workers.find((worker) => worker.role === role && worker.panelId) ?? null
  );
}

export function setActiveWorker(
  workers: AgentTeamWorker[],
  activeWorkerRole: AgentTeamWorkerRole | null,
): AgentTeamWorker[] {
  return workers.map((worker) => ({
    ...worker,
    frozen: !activeWorkerRole || worker.role !== activeWorkerRole,
  }));
}

export function shouldDispatchNextSerialWorker(
  run: AgentTeamRun,
  outbox: AgentTeamWorkerOutbox,
): boolean {
  if (outbox.status !== "completed") {
    return false;
  }
  const role = parseWorkerRole(outbox.role);
  return run.phase === "executing" && role === "code";
}

export function createActiveWorkerDispatch(
  worker: Pick<AgentTeamWorker, "role" | "panelId" | "tmuxPaneId">,
  requestedAt: string,
  outboxMtimeMs: number | null,
  round: number,
  reviewTarget: AgentTeamActiveWorkerDispatch["reviewTarget"] = null,
  options: Pick<
    AgentTeamActiveWorkerDispatch,
    | "repairKeys"
    | "dispatchId"
    | "outboxDispatchIdRequired"
    | "verifiedCheckpointCommit"
    | "checkpointAllowedDirtyPaths"
    | "checkpointRebasedCommit"
    | "protocolCorrectionAttempt"
    | "protocolCorrectionSourceFingerprint"
  > = {},
): AgentTeamActiveWorkerDispatch {
  return {
    dispatchId: options.dispatchId ?? randomUUID(),
    outboxDispatchIdRequired: options.outboxDispatchIdRequired ?? true,
    role: worker.role,
    panelId: worker.panelId ?? null,
    tmuxPaneId: worker.tmuxPaneId ?? null,
    round,
    requestedAt,
    outboxMtimeMs,
    reviewTarget,
    verifiedCheckpointCommit: options.verifiedCheckpointCommit ?? null,
    checkpointAllowedDirtyPaths: options.checkpointAllowedDirtyPaths ?? [],
    checkpointRebasedCommit: options.checkpointRebasedCommit ?? null,
    repairKeys: options.repairKeys ?? [],
    protocolCorrectionAttempt: options.protocolCorrectionAttempt ?? 0,
    protocolCorrectionSourceFingerprint:
      options.protocolCorrectionSourceFingerprint ?? null,
  };
}

export function completionReviewTargetMismatch(
  run: AgentTeamRun,
  outbox: AgentTeamWorkerOutbox,
): string | null {
  if (outbox.role !== "code_review" || !run.reviewCheckpoint) {
    return null;
  }
  const expected = run.activeWorkerDispatch?.reviewTarget;
  const actual = outbox.reviewTarget;
  if (!expected || !actual) {
    return "review_target_missing";
  }
  if (
    expected.scope !== actual.scope ||
    expected.baseCommit !== actual.baseCommit ||
    expected.targetTree !== actual.targetTree ||
    expected.planSha256 !== actual.planSha256 ||
    expected.testCaseSha256 !== actual.testCaseSha256 ||
    expected.requestedAt !== actual.requestedAt ||
    expected.changedPaths.join("\0") !== actual.changedPaths.join("\0")
  ) {
    return "review_target_mismatch";
  }
  return null;
}

export function resolveActiveWorkerDispatch(
  run: AgentTeamRun,
  worker: AgentTeamWorker,
): AgentTeamActiveWorkerDispatch | null {
  const persisted = run.activeWorkerDispatch;
  if (
    persisted &&
    persisted.role === worker.role &&
    (!persisted.panelId || persisted.panelId === worker.panelId) &&
    (!persisted.tmuxPaneId || persisted.tmuxPaneId === worker.tmuxPaneId)
  ) {
    return persisted;
  }
  if (run.workerDispatchProtocolVersion === 1) {
    return null;
  }
  const recheckCase = run.acceptance
    .filter(
      (item) =>
        item.status === "pending" &&
        item.recheckRequestedAt &&
        item.recheckWorkerRole === worker.role &&
        (!item.recheckWorkerPanelId ||
          item.recheckWorkerPanelId === worker.panelId),
    )
    .sort(
      (left, right) =>
        Date.parse(right.recheckRequestedAt!) -
        Date.parse(left.recheckRequestedAt!),
    )[0];
  if (recheckCase?.recheckRequestedAt) {
    return createActiveWorkerDispatch(
      worker,
      recheckCase.recheckRequestedAt,
      recheckCase.recheckOutboxMtimeMs ?? null,
      run.loop.round,
      worker.role === "code_review"
        ? (run.reviewCheckpoint?.pendingReview ?? null)
        : null,
      {
        dispatchId:
          recheckCase.recheckDispatchId ??
          createLegacyDispatchId(run, worker, recheckCase.recheckRequestedAt),
        outboxDispatchIdRequired: false,
      },
    );
  }
  return createActiveWorkerDispatch(
    worker,
    run.updatedAt,
    null,
    run.loop.round,
    worker.role === "code_review"
      ? (run.reviewCheckpoint?.pendingReview ?? null)
      : null,
    {
      dispatchId: createLegacyDispatchId(run, worker, run.updatedAt),
      outboxDispatchIdRequired: false,
    },
  );
}

function createLegacyDispatchId(
  run: AgentTeamRun,
  worker: Pick<AgentTeamWorker, "role" | "panelId" | "tmuxPaneId">,
  requestedAt: string,
): string {
  const digest = createHash("sha256")
    .update(
      [
        run.runId,
        worker.role,
        worker.panelId ?? "",
        worker.tmuxPaneId ?? "",
        requestedAt,
      ].join("\0"),
    )
    .digest("hex")
    .slice(0, 20);
  return `legacy-${digest}`;
}

export function completionSignalWorkerMismatch(
  event: Extract<TerminalEventEnvelope, { kind: "completion" }>,
  worker: AgentTeamWorker,
): string | null {
  if (event.payload.panelId && event.payload.panelId !== worker.panelId) {
    return "signal_panel_mismatch";
  }
  if (
    event.payload.tmuxPaneId &&
    event.payload.tmuxPaneId !== worker.tmuxPaneId
  ) {
    return "signal_tmux_pane_mismatch";
  }
  return null;
}

export function completionOutboxIdentityMismatch(
  run: AgentTeamRun,
  worker: AgentTeamWorker,
  dispatch: AgentTeamActiveWorkerDispatch,
  outbox: AgentTeamWorkerOutbox,
  requireRunId: boolean,
): string | null {
  if (requireRunId && !outbox.runId) {
    return "outbox_run_id_missing";
  }
  if (outbox.runId && outbox.runId !== run.runId) {
    return "outbox_run_id_mismatch";
  }
  if (outbox.sessionId !== run.terminalSessionId) {
    return "outbox_session_mismatch";
  }
  if (outbox.projectId && outbox.projectId !== run.projectId) {
    return "outbox_project_mismatch";
  }
  if (parseWorkerRole(outbox.role) !== run.activeWorkerRole) {
    return "outbox_role_mismatch";
  }
  if (outbox.panelId && outbox.panelId !== worker.panelId) {
    return "outbox_panel_mismatch";
  }
  if (outbox.tmuxPaneId && outbox.tmuxPaneId !== worker.tmuxPaneId) {
    return "outbox_tmux_pane_mismatch";
  }
  const matchesPanel = Boolean(
    worker.panelId && outbox.panelId === worker.panelId,
  );
  const matchesTmuxPane = Boolean(
    worker.tmuxPaneId && outbox.tmuxPaneId === worker.tmuxPaneId,
  );
  if (!matchesPanel && !matchesTmuxPane) {
    return "outbox_pane_identity_missing";
  }
  const expectedDispatchId = dispatch.dispatchId?.trim() ?? "";
  const actualDispatchId = outbox.dispatchId?.trim() ?? "";
  const dispatchIdRequired =
    run.workerDispatchProtocolVersion === 1 ||
    dispatch.outboxDispatchIdRequired === true;
  if (dispatchIdRequired) {
    if (!expectedDispatchId) {
      return "active_dispatch_id_missing";
    }
    if (!actualDispatchId) {
      return "outbox_dispatch_id_missing";
    }
  }
  if (
    expectedDispatchId &&
    actualDispatchId &&
    actualDispatchId !== expectedDispatchId
  ) {
    return "outbox_dispatch_id_mismatch";
  }
  return null;
}

export function workerOutboxFreshnessMismatch(
  dispatch: AgentTeamActiveWorkerDispatch,
  outboxMtimeMs: number | null,
): string | null {
  if (outboxMtimeMs === null) {
    return "outbox_mtime_unavailable";
  }
  if (dispatch.outboxMtimeMs !== null) {
    return outboxMtimeMs > dispatch.outboxMtimeMs
      ? null
      : "outbox_not_newer_than_dispatch_baseline";
  }
  const requestedAtMs = Date.parse(dispatch.requestedAt);
  if (!Number.isFinite(requestedAtMs)) {
    return "dispatch_requested_at_invalid";
  }
  return outboxMtimeMs > requestedAtMs
    ? null
    : "outbox_not_newer_than_dispatch";
}

export function normalizeWorkers(
  workers: Array<Pick<AgentTeamWorker, "role" | "intent">> | undefined,
): AgentTeamWorker[] {
  const source =
    workers && workers.length > 0
      ? workers
      : [
          { role: "code" as const, intent: "实现任务目标中的核心改动" },
          { role: "code_review" as const, intent: "审查改动与回归覆盖" },
          {
            role: "behavior_verify" as const,
            intent: "按验收用例跑 Playwright，回传 pass/fail + 证据",
          },
        ];
  return source.map((worker) => {
    workerCounter += 1;
    const role = VALID_WORKER_ROLES.includes(worker.role as AgentTeamWorkerRole)
      ? (worker.role as AgentTeamWorkerRole)
      : "code";
    return {
      id: `w_${Date.now()}_${workerCounter}`,
      role,
      intent: worker.intent?.trim() || `${role} worker`,
      panelId: null,
      tmuxPaneId: null,
      frozen: false,
    };
  });
}
