import { parentPort, workerData } from "node:worker_threads";
import { EvolutionActivationDatabase } from "./database";
import type {
  EvolutionWorkerCommand,
  EvolutionWorkerResponse,
  EvolutionWorkerResult,
} from "./worker-protocol";

if (!parentPort) throw new Error("evolution_worker_parent_port_required");
const port = parentPort;

const database = new EvolutionActivationDatabase(
  (workerData as { databasePath: string }).databasePath,
);

function execute(command: EvolutionWorkerCommand): EvolutionWorkerResult {
  switch (command.op) {
    case "list-candidates":
      return database.listCandidates();
    case "put-candidate":
      database.putCandidate(command.candidate);
      return true;
    case "get-policy":
      return database.getPolicy(command.learningScopeId);
    case "put-policy":
      database.putPolicy(command.policy);
      return true;
    case "put-trace":
      database.putRuntimeTrace(command.trace);
      return true;
    case "append-trace-event":
      database.appendRuntimeTraceEvent(command.event);
      return true;
    case "get-trace":
      return database.getRuntimeTrace(command.traceId);
    case "list-traces":
      return database.listRuntimeTraces(command.runId);
    case "integrity":
      return database.integrity();
    case "close":
      database.close();
      return true;
  }
}

port.on("message", (command: EvolutionWorkerCommand) => {
  let response: EvolutionWorkerResponse;
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
