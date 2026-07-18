import { randomUUID } from "node:crypto";
import type { AgentTeamRun } from "@runweave/shared/agent-team";
import type {
  ActivityEventInput,
  AgentTeamActivityPayload,
  AgentTeamActivityPurpose,
  AgentTeamActivityReasonCode,
} from "@runweave/shared/activity";
import type { TerminalActivityDependencies } from "../terminal/activity-events";

function structuredPayload(
  transitionId: string,
  purpose: AgentTeamActivityPurpose,
  reasonCode: AgentTeamActivityReasonCode,
  payload: ActivityEventInput["payload"],
): AgentTeamActivityPayload {
  return { ...payload, transitionId, reasonCode, purpose };
}

function dispatchPurpose(
  dispatch: AgentTeamRun["activeWorkerDispatch"],
): AgentTeamActivityPurpose {
  if ((dispatch?.protocolCorrectionAttempt ?? 0) > 0) {
    return "protocol_correction";
  }
  if ((dispatch?.repairKeys?.length ?? 0) > 0) {
    return "repair";
  }
  if (dispatch?.role === "code_review") {
    return "review";
  }
  if (dispatch?.role === "behavior_verify") {
    return "full_behavior";
  }
  return "initial_code";
}

function dispatchReasonCode(
  purpose: AgentTeamActivityPurpose,
): AgentTeamActivityReasonCode {
  switch (purpose) {
    case "protocol_correction":
      return "protocol_correction_requested";
    case "repair":
      return "repair_requested";
    case "review":
      return "review_requested";
    case "full_behavior":
      return "behavior_verification_requested";
    default:
      return "code_execution_requested";
  }
}

function runReasonCode(
  previous: AgentTeamRun | null,
  current: AgentTeamRun,
): AgentTeamActivityReasonCode {
  if (!previous) return "run_created";
  if (current.status === "done") return "run_succeeded";
  if (current.status === "failed") return "run_failed";
  if (current.status === "cancelled") return "run_cancelled";
  if (current.pendingFindingDecision) return "scope_decision_required";
  if (current.frameworkRepair?.result === "blocked") {
    return "framework_repair_blocked";
  }
  if (current.status === "need_human" || current.loop.escalated) {
    return "recovery_required";
  }
  if (previous.status === "need_human" && current.status === "running") {
    return "run_resumed";
  }
  if (previous.phase !== current.phase && previous.status !== current.status) {
    return "phase_and_status_changed";
  }
  if (previous.phase !== current.phase) return "phase_changed";
  return "status_changed";
}

export function recordAgentTeamRunTransition(
  activity: TerminalActivityDependencies | undefined,
  previous: AgentTeamRun | null,
  current: AgentTeamRun,
): void {
  if (!activity) return;
  const events: ActivityEventInput[] = [];
  const transitionId = randomUUID();
  const eventName = !previous
    ? "agent_team.run.created"
    : current.status === "done" ||
        current.status === "failed" ||
        current.status === "cancelled"
      ? "agent_team.run.completed"
      : previous.phase !== current.phase || previous.status !== current.status
        ? "agent_team.run.state_changed"
        : null;
  if (eventName) {
    events.push(
      activity.eventFactory.create({
        eventName,
        occurredAt: current.updatedAt,
        actorType: "system",
        scope: {
          projectId: current.projectId,
          terminalSessionId: current.terminalSessionId,
          runId: current.runId,
        },
        payload: structuredPayload(
          transitionId,
          "run_lifecycle",
          runReasonCode(previous, current),
          {
            phase: current.phase,
            status: current.status,
            nextRoundIndex: current.loop.round,
            ...(previous
              ? {
                  previousPhase: previous.phase,
                  previousStatus: previous.status,
                }
              : {}),
          },
        ),
        result:
          current.status === "done"
            ? { status: "succeeded" }
            : current.status === "failed"
              ? { status: "failed" }
              : current.status === "cancelled"
                ? { status: "cancelled" }
                : undefined,
      }),
    );
  }

  const dispatch = current.activeWorkerDispatch;
  if (
    dispatch &&
    dispatch.requestedAt !== previous?.activeWorkerDispatch?.requestedAt
  ) {
    const worker = current.workers.find((item) => item.role === dispatch.role);
    const dispatchRound = dispatch.round;
    const purpose = dispatchPurpose(dispatch);
    events.push(
      activity.eventFactory.create({
        eventName: "agent_team.worker.dispatched",
        occurredAt: dispatch.requestedAt,
        actorType: "system",
        scope: {
          projectId: current.projectId,
          terminalSessionId: current.terminalSessionId,
          runId: current.runId,
          panelId: dispatch.panelId ?? undefined,
          tmuxPaneId: dispatch.tmuxPaneId ?? undefined,
        },
        payload: structuredPayload(
          transitionId,
          purpose,
          dispatchReasonCode(purpose),
          {
            workerId: worker?.id ?? null,
            role: dispatch.role,
            dispatchId: dispatch.dispatchId ?? null,
            ...(dispatchRound ? { round: dispatchRound } : {}),
            attempt: Math.max(
              1,
              ...current.acceptance
                .filter(
                  (item) => item.recheckRequestedAt === dispatch.requestedAt,
                )
                .map((item) => item.recheckAttempt ?? 1),
            ),
          },
        ),
      }),
    );
  }

  const previousCases = new Map(
    (previous?.acceptance ?? []).map((item) => [item.caseId, item]),
  );
  const dispatchedCases = current.acceptance.filter((item) => {
    const prior = previousCases.get(item.caseId);
    return Boolean(
      item.recheckRequestedAt &&
      item.recheckRequestedAt !== prior?.recheckRequestedAt,
    );
  });
  for (const item of dispatchedCases) {
    const activeDispatch = current.activeWorkerDispatch;
    const dispatchRound = activeDispatch?.round;
    const purpose = dispatchPurpose(activeDispatch);
    events.push(
      activity.eventFactory.create({
        eventName: "agent_team.case.dispatched",
        occurredAt: item.recheckRequestedAt ?? current.updatedAt,
        actorType: "system",
        scope: {
          projectId: current.projectId,
          terminalSessionId: current.terminalSessionId,
          runId: current.runId,
          panelId: item.recheckWorkerPanelId ?? undefined,
        },
        payload: structuredPayload(
          transitionId,
          purpose,
          "acceptance_case_dispatched",
          {
            caseId: item.caseId,
            sourceCaseId: item.sourceCaseId ?? null,
            sourceFilePath: item.sourceFilePath ?? null,
            workerRole: item.recheckWorkerRole ?? null,
            dispatchId:
              item.recheckDispatchId ?? activeDispatch?.dispatchId ?? null,
            ...(dispatchRound ? { round: dispatchRound } : {}),
            attempt: item.recheckAttempt ?? 1,
          },
        ),
      }),
    );
  }

  const recordedCases = current.acceptance.filter((item) => {
    const prior = previousCases.get(item.caseId);
    return item.status !== "pending" && item.status !== prior?.status;
  });
  for (const item of recordedCases) {
    const resultDispatch = previous?.activeWorkerDispatch;
    const recordedRound = resultDispatch?.round;
    events.push(
      activity.eventFactory.create({
        eventName: "agent_team.case.result_recorded",
        occurredAt: current.updatedAt,
        actorType: "system",
        scope: {
          projectId: current.projectId,
          terminalSessionId: current.terminalSessionId,
          runId: current.runId,
          panelId: item.recheckWorkerPanelId ?? undefined,
        },
        payload: structuredPayload(
          transitionId,
          resultDispatch
            ? dispatchPurpose(resultDispatch)
            : "acceptance_result",
          item.status === "pass" ? "acceptance_passed" : "acceptance_failed",
          {
            caseId: item.caseId,
            reportedStatus: item.status,
            summary: item.resultSummary ?? null,
            evidenceCount: item.evidence.length,
            dispatchId: resultDispatch?.dispatchId ?? null,
            ...(recordedRound ? { round: recordedRound } : {}),
            attempt: item.recheckAttempt ?? 1,
          },
        ),
      }),
    );
  }
  if (recordedCases.length > 0 && previous?.activeWorkerDispatch) {
    const resultDispatch = previous.activeWorkerDispatch;
    const recordedRound = resultDispatch.round;
    const reportedStatus = recordedCases.some((item) => item.status === "fail")
      ? "failed"
      : "completed";
    events.push(
      activity.eventFactory.create({
        eventName: "agent_team.worker.result_recorded",
        occurredAt: current.updatedAt,
        actorType: "system",
        scope: {
          projectId: current.projectId,
          terminalSessionId: current.terminalSessionId,
          runId: current.runId,
          panelId: resultDispatch.panelId ?? undefined,
          tmuxPaneId: resultDispatch.tmuxPaneId ?? undefined,
        },
        payload: structuredPayload(
          transitionId,
          dispatchPurpose(resultDispatch),
          reportedStatus === "failed"
            ? "worker_result_failed"
            : "worker_result_completed",
          {
            role: resultDispatch.role,
            reportedStatus,
            dispatchId: resultDispatch.dispatchId ?? null,
            ...(recordedRound ? { round: recordedRound } : {}),
            caseCount: recordedCases.length,
          },
        ),
      }),
    );
  }

  if (events.length > 0) {
    void activity.recorder.recordBatch(events);
  }
}
