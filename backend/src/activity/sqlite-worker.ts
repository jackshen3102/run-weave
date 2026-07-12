import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { ActivityDatabase, type ActivityDatabaseOptions } from "./activity-database";
import type { ActivityWorkerRequest, ActivityWorkerResponse } from "./worker-protocol";

if (isMainThread || !parentPort) {
  throw new Error("activity_sqlite_worker_must_run_in_worker_thread");
}

const workerParentPort = parentPort;

const database = new ActivityDatabase(workerData as ActivityDatabaseOptions);

function handleRequest(request: ActivityWorkerRequest): unknown {
  switch (request.op) {
    case "record":
      return database.record(request.events, request.nowMs);
    case "facts":
      return database.facts(request.query);
    case "timeline":
      return database.timeline(request.selector, request.query);
    case "sources":
      return database.sources();
    case "policy":
      return database.policy();
    case "content":
      return database.content(request.contentId);
    case "audit-subject-hmac":
      return database.auditSubjectHmac(request.subject);
    case "rejection":
      return database.rejection(request);
    case "audit":
      return database.recordAccessAudit(request);
    case "preview":
      return database.preview(request.scope, request.asOfActivityOffset);
    case "export-snapshot":
      return database.exportSnapshot(request);
    case "create-delete-job":
      return database.createDeleteJob(request);
    case "delete-status":
      return database.deleteStatus(request.deleteJobId);
    case "run-delete":
      return database.runDelete(request.ownerId, request.nowMs);
    case "run-retention":
      return database.runRetention(request.ownerId, request.nowMs);
    case "integrity":
      return database.integrity();
    case "close":
      database.close();
      return true;
  }
}

workerParentPort.on("message", (request: ActivityWorkerRequest) => {
  let response: ActivityWorkerResponse;
  try {
    response = { id: request.id, ok: true, result: handleRequest(request) as never };
  } catch (error) {
    response = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  workerParentPort.postMessage(response);
  if (request.op === "close") {
    workerParentPort.close();
  }
});
