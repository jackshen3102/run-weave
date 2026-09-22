import type {
  ScheduledRun,
  ScheduledTask,
  ScheduledTerminalBinding,
} from "@runweave/shared/scheduled-tasks";

export type ScheduledTaskWorkerCommand =
  | { id: number; op: "integrity" }
  | { id: number; op: "close" }
  | {
      id: number;
      op: "create-task";
      task: ScheduledTask;
      parentProjectId: string;
      idempotencyKey: string;
      requestHash: string;
    }
  | { id: number; op: "get-task"; taskId: string }
  | { id: number; op: "list-tasks" }
  | {
      id: number;
      op: "update-task";
      task: ScheduledTask;
      expectedRevision: number;
      parentProjectId: string;
    }
  | { id: number; op: "list-due-tasks"; through: string }
  | {
      id: number;
      op: "materialize-scheduled-run";
      run: ScheduledRun;
      occurrenceKey: string;
      nextRunAt: string | null;
      taskRevision: number;
      expectedNextRunAt: string;
    }
  | {
      id: number;
      op: "create-manual-run";
      run: ScheduledRun;
      idempotencyKey: string;
      requestHash: string;
    }
  | { id: number; op: "get-run"; runId: string }
  | { id: number; op: "list-runs"; taskId: string }
  | { id: number; op: "claim-next-run"; ownerId: string; now: string }
  | { id: number; op: "put-run"; run: ScheduledRun }
  | {
      id: number;
      op: "set-run-owner-pid";
      runId: string;
      ownerId: string;
      ownerPid: number;
    }
  | {
      id: number;
      op: "recover-interrupted-runs";
      now: string;
      currentOwnerId: string;
    }
  | { id: number; op: "request-run-stop"; runId: string; now: string }
  | {
      id: number;
      op: "append-output";
      runId: string;
      text: string;
      maxBytes: number;
    }
  | {
      id: number;
      op: "read-output";
      runId: string;
      offset: number;
      maxBytes: number;
    }
  | {
      id: number;
      op: "put-binding";
      runId: string;
      binding: ScheduledTerminalBinding;
    };

export type ScheduledTaskWorkerRequest =
  ScheduledTaskWorkerCommand extends infer Command
    ? Command extends { id: number }
      ? Omit<Command, "id">
      : never
    : never;

export interface ScheduledOutputChunk {
  text: string;
  nextOffset: number;
  totalBytes: number;
}

export type ScheduledTaskWorkerResult =
  | ScheduledTask
  | ScheduledTask[]
  | ScheduledRun
  | ScheduledRun[]
  | ScheduledOutputChunk
  | boolean
  | null;

export type ScheduledTaskWorkerResponse =
  | { id: number; ok: true; result: ScheduledTaskWorkerResult }
  | { id: number; ok: false; error: string };
