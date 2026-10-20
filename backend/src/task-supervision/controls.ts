import { randomUUID } from "node:crypto";
import type {
  ChangeSupervisionRequest, ChangeSupervisionResponse, StartSupervisionRequest, SupervisionTarget, TaskWatch,
} from "@runweave/shared/task-supervision";
import { digest } from "./context";
import { SupervisionError } from "./errors";
import { findTerminalWatch, type SupervisionJournal } from "./store";
import { sameTarget, synchronizeTarget } from "./synchronization";

interface WatchControls {
  find: (id: string) => TaskWatch;
  resolve: (terminalSessionId: string) => { target: SupervisionTarget };
  cancel: (id: string) => void;
  removeTerminal: (terminalSessionId: string) => void;
  receipt: (id: string) => { digest: string; watchId: string } | undefined;
}

/** Mutations run within the service transaction, including idempotency and cancellation. */
export function startWatch(journal: SupervisionJournal, request: StartSupervisionRequest, operations: WatchControls): TaskWatch {
  const requestDigest = digest(JSON.stringify(request));
  const previous = journal.requests[request.requestId] ?? operations.receipt(request.requestId);
  if (previous) {
    if (previous.digest !== requestDigest)
      throw new SupervisionError("requestId 已用于不同请求。");
    return operations.find(previous.watchId);
  }
  const { target } = operations.resolve(request.target.terminalSessionId);
  if (!sameTarget(request.target, target)) throw new SupervisionError("目标会话已变化，请刷新后开启监控。");
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

export function changeWatch(id: string, request: ChangeSupervisionRequest, operations: WatchControls): ChangeSupervisionResponse {
  const watch = operations.find(id);
  if (watch.revision !== request.expectedRevision)
    throw new SupervisionError("监控状态已更新，请刷新。");
  if (request.action === "pause") {
    operations.removeTerminal(watch.target.terminalSessionId);
    return null;
  }
  operations.cancel(id);
  delete watch.pendingReply;
  if (request.action === "resume") {
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
    watch.goalOverride = request.goal;
    delete watch.goalCheckedMessageId;
    watch.goalState = "needs_review";
    watch.goalReason = "目标已修改，需重新整理完成条件和范围。";
    watch.contextRevision++;
    if (watch.status === "classifying") watch.status = "watching";
  }
  watch.revision++;
  watch.updatedAt = new Date().toISOString();
  delete watch.error;
  return watch;
}
