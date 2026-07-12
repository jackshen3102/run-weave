import type { AgentTeamRun } from "@runweave/shared/agent-team";
import type { ActivityEventInput } from "@runweave/shared/activity";
import type { TerminalActivityDependencies } from "../terminal/activity-events";

export function recordAgentTeamRunTransition(
  activity: TerminalActivityDependencies | undefined,
  previous: AgentTeamRun | null,
  current: AgentTeamRun,
): void {
  if (!activity) return;
  const events: ActivityEventInput[] = [];
  const eventName = !previous
    ? "agent_team.run.created"
    : current.status === "done" || current.status === "failed"
      ? "agent_team.run.completed"
      : previous.phase !== current.phase || previous.status !== current.status
        ? "agent_team.run.state_changed"
        : null;
  if (eventName) {
    events.push(activity.eventFactory.create({
      eventName,
      occurredAt: current.updatedAt,
      actorType: "system",
      scope: {
        projectId: current.projectId,
        terminalSessionId: current.terminalSessionId,
        runId: current.runId,
      },
      payload: {
        phase: current.phase,
        status: current.status,
        round: current.loop.round,
        ...(previous ? { previousPhase: previous.phase, previousStatus: previous.status } : {}),
      },
      result:
        current.status === "done"
          ? { status: "succeeded" }
          : current.status === "failed"
            ? { status: "failed" }
            : undefined,
    }));
  }

  const dispatch = current.activeWorkerDispatch;
  if (
    dispatch &&
    dispatch.requestedAt !== previous?.activeWorkerDispatch?.requestedAt
  ) {
    const worker = current.workers.find((item) => item.role === dispatch.role);
    events.push(activity.eventFactory.create({
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
      payload: {
        workerId: worker?.id ?? null,
        role: dispatch.role,
        attempt: Math.max(
          1,
          ...current.acceptance
            .filter((item) => item.recheckRequestedAt === dispatch.requestedAt)
            .map((item) => item.recheckAttempt ?? 1),
        ),
      },
    }));
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
    events.push(activity.eventFactory.create({
      eventName: "agent_team.case.dispatched",
      occurredAt: item.recheckRequestedAt ?? current.updatedAt,
      actorType: "system",
      scope: {
        projectId: current.projectId,
        terminalSessionId: current.terminalSessionId,
        runId: current.runId,
        panelId: item.recheckWorkerPanelId ?? undefined,
      },
      payload: {
        caseId: item.caseId,
        sourceCaseId: item.sourceCaseId ?? null,
        sourceFilePath: item.sourceFilePath ?? null,
        workerRole: item.recheckWorkerRole ?? null,
        attempt: item.recheckAttempt ?? 1,
      },
    }));
  }

  const recordedCases = current.acceptance.filter((item) => {
    const prior = previousCases.get(item.caseId);
    return item.status !== "pending" && item.status !== prior?.status;
  });
  for (const item of recordedCases) {
    events.push(activity.eventFactory.create({
      eventName: "agent_team.case.result_recorded",
      occurredAt: current.updatedAt,
      actorType: "system",
      scope: {
        projectId: current.projectId,
        terminalSessionId: current.terminalSessionId,
        runId: current.runId,
        panelId: item.recheckWorkerPanelId ?? undefined,
      },
      payload: {
        caseId: item.caseId,
        reportedStatus: item.status,
        summary: item.resultSummary ?? null,
        evidenceCount: item.evidence.length,
        attempt: item.recheckAttempt ?? 1,
      },
    }));
  }
  if (recordedCases.length > 0 && previous?.activeWorkerDispatch) {
    events.push(activity.eventFactory.create({
      eventName: "agent_team.worker.result_recorded",
      occurredAt: current.updatedAt,
      actorType: "system",
      scope: {
        projectId: current.projectId,
        terminalSessionId: current.terminalSessionId,
        runId: current.runId,
        panelId: previous.activeWorkerDispatch.panelId ?? undefined,
        tmuxPaneId: previous.activeWorkerDispatch.tmuxPaneId ?? undefined,
      },
      payload: {
        role: previous.activeWorkerDispatch.role,
        reportedStatus: recordedCases.some((item) => item.status === "fail")
          ? "failed"
          : "completed",
        caseCount: recordedCases.length,
      },
    }));
  }

  if (events.length > 0) {
    void activity.recorder.recordBatch(events);
  }
}
