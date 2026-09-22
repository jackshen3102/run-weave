import { parentPort, workerData } from "node:worker_threads";
import { ScheduledTaskDatabase } from "./database";
import type {
  ScheduledTaskWorkerCommand,
  ScheduledTaskWorkerResponse,
} from "./worker-protocol";

const port = parentPort;
if (!port) throw new Error("scheduled_tasks_worker_requires_parent_port");
const database = new ScheduledTaskDatabase(
  (workerData as { databasePath: string }).databasePath,
);

function execute(command: ScheduledTaskWorkerCommand) {
  switch (command.op) {
    case "integrity":
      return database.integrity();
    case "close":
      database.close();
      return true;
    case "create-task":
      return database.createTask(
        command.task,
        command.parentProjectId,
        command.idempotencyKey,
        command.requestHash,
      );
    case "get-task":
      return database.getTask(command.taskId);
    case "list-tasks":
      return database.listTasks();
    case "update-task":
      return database.updateTask(
        command.task,
        command.expectedRevision,
        command.parentProjectId,
      );
    case "list-due-tasks":
      return database.listDueTasks(command.through);
    case "materialize-scheduled-run":
      return database.materializeScheduledRun(
        command.run,
        command.occurrenceKey,
        command.nextRunAt,
        command.taskRevision,
        command.expectedNextRunAt,
      );
    case "create-manual-run":
      return database.createManualRun(
        command.run,
        command.idempotencyKey,
        command.requestHash,
      );
    case "get-run":
      return database.getRun(command.runId);
    case "list-runs":
      return database.listRuns(command.taskId);
    case "claim-next-run":
      return database.claimNextRun(command.ownerId, command.now);
    case "put-run":
      return database.putRun(command.run);
    case "set-run-owner-pid":
      return database.setRunOwnerPid(
        command.runId,
        command.ownerId,
        command.ownerPid,
      );
    case "recover-interrupted-runs":
      return database.recoverInterruptedRuns(
        command.now,
        command.currentOwnerId,
      );
    case "request-run-stop":
      return database.requestRunStop(command.runId, command.now);
    case "append-output":
      return database.appendOutput(
        command.runId,
        command.text,
        command.maxBytes,
      );
    case "read-output":
      return database.readOutput(
        command.runId,
        command.offset,
        command.maxBytes,
      );
    case "put-binding":
      return database.putBinding(command.runId, command.binding);
  }
}

port.on("message", (command: ScheduledTaskWorkerCommand) => {
  let response: ScheduledTaskWorkerResponse;
  try {
    response = { id: command.id, ok: true, result: execute(command) };
  } catch (error) {
    response = {
      id: command.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  port.postMessage(response);
  if (command.op === "close") port.close();
});
