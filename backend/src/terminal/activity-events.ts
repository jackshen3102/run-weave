import type { ActivityEventFactory } from "../activity/event-factory";
import type { ActivityRecorder } from "../activity/activity-recorder";
import type { TerminalSessionRecord } from "./manager-records";

export interface TerminalActivityDependencies {
  recorder: ActivityRecorder;
  eventFactory: ActivityEventFactory;
}

export function recordTerminalSessionCreated(
  activity: TerminalActivityDependencies | undefined,
  session: TerminalSessionRecord,
): void {
  activity?.recorder.record(
    activity.eventFactory.create({
      eventName: "terminal.session.created",
      occurredAt: session.createdAt.toISOString(),
      actorType: "user",
      scope: {
        projectId: session.projectId,
        terminalSessionId: session.id,
        cwd: session.cwd,
      },
      payload: { runtimeKind: session.runtimeKind, status: session.status },
    }),
  );
}

export function recordTerminalSessionDeleted(
  activity: TerminalActivityDependencies | undefined,
  session: TerminalSessionRecord | undefined,
): void {
  if (!session) return;
  activity?.recorder.record(
    activity.eventFactory.create({
      eventName: "terminal.session.deleted",
      actorType: "user",
      scope: {
        projectId: session.projectId,
        terminalSessionId: session.id,
        cwd: session.cwd,
      },
      payload: {
        previousStatus: session.status,
        ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
        reason: "user",
      },
      result: { status: "succeeded" },
    }),
  );
}
