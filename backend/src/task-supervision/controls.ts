import { randomUUID } from "node:crypto";
import type {
  ChangeSupervisionRequest, StartSupervisionRequest, SupervisionTarget, TaskWatch,
} from "@runweave/shared/task-supervision";
import { digest } from "./context";
import { SupervisionError } from "./errors";
import { findTerminalWatch, type SupervisionJournal } from "./store";
import { synchronizeTarget } from "./synchronization";

interface WatchControls {
  find: (id: string) => TaskWatch;
  resolve: (terminalSessionId: string) => { target: SupervisionTarget };
  cancel: (id: string) => void;
}

/** Mutations run within the service transaction, including idempotency and cancellation. */
export function startWatch(journal: SupervisionJournal, request: StartSupervisionRequest, operations: WatchControls): TaskWatch {
  const requestDigest = digest(JSON.stringify(request));
  const previous = journal.requests[request.requestId];
  if (previous) {
    if (previous.digest !== requestDigest)
      throw new SupervisionError("requestId 已用于不同请求。");
    return operations.find(previous.watchId);
  }
  const { target } = operations.resolve(request.target.terminalSessionId);
  let watch = findTerminalWatch(journal, target.terminalSessionId);
  if (!watch) {
    const now = new Date().toISOString();
    const pendingId = `pending:${randomUUID()}`;
    watch = {
      watchId: randomUUID(),
      enabled: true,
      enabledAt: now,
      target,
      taskStartMessageId: pendingId,
      task: { id: pendingId, role: "user", text: "", createdAt: now },
      goal: "",
      plans: [],
      revision: 1,
      contextRevision: 1,
      status: "watching",
      outcome: null,
      continuationLimit: 3,
      continuationCount: 0,
      decisions: [],
      createdAt: now,
      updatedAt: now,
    };
    journal.watches.push(watch);
  } else {
    operations.cancel(watch.watchId);
    synchronizeTarget(watch, target);
    watch.enabled = true;
    watch.enabledAt = new Date().toISOString();
    watch.status = "watching";
    delete watch.pauseReason;
    delete watch.error;
    watch.revision++;
    watch.updatedAt = new Date().toISOString();
  }
  journal.requests[request.requestId] = {
    digest: requestDigest,
    watchId: watch.watchId,
  };
  return watch;
}

export function changeWatch(id: string, request: ChangeSupervisionRequest, operations: WatchControls) {
  const watch = operations.find(id);
  if (watch.revision !== request.expectedRevision)
    throw new SupervisionError("监控状态已更新，请刷新。");
  operations.cancel(id);
  if (request.action === "pause") {
    watch.enabled = false;
    watch.status = "paused";
    watch.pauseReason = "user_paused";
  } else if (request.action === "resume") {
    synchronizeTarget(
      watch,
      operations.resolve(watch.target.terminalSessionId).target,
    );
    watch.enabled = true;
    watch.enabledAt = new Date().toISOString();
    watch.status = "watching";
    delete watch.pauseReason;
  } else {
    if (!request.goal?.trim())
      throw new SupervisionError("目标不能为空。", 422);
    watch.goal = request.goal;
    watch.contextRevision++;
    if (watch.status === "classifying") watch.status = "watching";
  }
  watch.revision++;
  watch.updatedAt = new Date().toISOString();
  delete watch.error;
  return watch;
}
