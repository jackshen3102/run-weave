import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { SessionSearchDatabase } from "./database";
import { NativeSearchScanner } from "./scanner";
import type { SearchWorkerOptions, SearchWorkerRequest, SearchWorkerResponse } from "./protocol";

if (isMainThread || !parentPort) throw new Error("session_search_worker_required");
const port = parentPort;
const options = workerData as SearchWorkerOptions;
const scanner = new NativeSearchScanner(new SessionSearchDatabase(options.file), options.roots);
async function execute({ command }: SearchWorkerRequest): Promise<unknown> {
  switch (command.op) {
    case "ready": return true;
    case "status": return scanner.status();
    case "refresh": await scanner.refresh(); return scanner.status();
    case "search":
      if (!command.query.noUpdate) await scanner.refresh();
      return scanner.database.search(command.query, scanner.status());
    case "context":
      if (!command.noUpdate) await scanner.refresh();
      return scanner.context(command.id);
    case "close": await scanner.close(); return true;
  }
}
port.on("message", (request: SearchWorkerRequest) => {
  void execute(request).then(value => {
    port.postMessage({ id: request.id, value } satisfies SearchWorkerResponse);
    if (request.command.op === "close") port.close();
  }, (error: unknown) => {
    port.postMessage({ id: request.id, error: error instanceof Error ? error.message : "session_search_failed" } satisfies SearchWorkerResponse);
  });
});
