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
): AgentTeamActiveWorkerDispatch {
  return {
    role: worker.role,
    panelId: worker.panelId ?? null,
    tmuxPaneId: worker.tmuxPaneId ?? null,
    requestedAt,
    outboxMtimeMs,
  };
}

export function resolveActiveWorkerDispatch(
  run: AgentTeamRun,
  worker: AgentTeamWorker,
): AgentTeamActiveWorkerDispatch {
  const persisted = run.activeWorkerDispatch;
  if (
    persisted &&
    persisted.role === worker.role &&
    (!persisted.panelId || persisted.panelId === worker.panelId) &&
    (!persisted.tmuxPaneId || persisted.tmuxPaneId === worker.tmuxPaneId)
  ) {
    return persisted;
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
    );
  }
  return createActiveWorkerDispatch(worker, run.updatedAt, null);
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
