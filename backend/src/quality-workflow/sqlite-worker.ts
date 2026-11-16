import { parentPort, workerData } from "node:worker_threads";
import { QualityDatabase, QualityError } from "./database";
import type { QualityCommand } from "./store";
if (!parentPort) throw new Error("quality_worker_requires_parent");
const port = parentPort;
const input = workerData as { file: string; backendId: string; maxBytes?: number; retentionDays?: number };
const database = new QualityDatabase(input.file, input.backendId, input.maxBytes, input.retentionDays);
port.on("message", ({ id, command }: { id: number; command: QualityCommand }) => {
  try {
    let result: unknown;
    switch (command.op) {
      case "ready": result = true; break;
      case "ingest": result = database.ingest(command.batch, command.projects, command.checkpoint); break;
      case "events": result = database.events(command.cursor, command.limit); break;
      case "context": result = database.context(command.request); break;
      case "coverage": result = database.coverage(); break;
      case "ledger": result = database.ledger(command.issueId); break;
      case "commit": result = database.commit(command.request); break;
      case "offsets": result = database.offsets(); break;
      case "close": database.close(); result = true; break;
    }
    port.postMessage({ id, result });
    if (command.op === "close") port.close();
  } catch (error) {
    port.postMessage({ id, error: error instanceof QualityError ? { status: error.status, code: error.code, details: error.details } : { status: 503, code: "quality_store_unavailable" } });
  }
});
