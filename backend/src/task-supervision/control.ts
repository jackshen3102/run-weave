import type { ConversationContent } from "@runweave/shared/terminal/conversation";
import type {
  ChangeSupervisionRequest,
  TaskWatch,
} from "@runweave/shared/task-supervision";
import { SupervisionError } from "./errors";
import { messagesFrom } from "./context";
import { latestFinalId } from "./final-cursor";

export async function changeWatch(
  watch: TaskWatch,
  request: ChangeSupervisionRequest,
  isCurrent: () => boolean,
  readHistory: () => Promise<ConversationContent>,
) {
  if (watch.revision !== request.expectedRevision)
    throw new SupervisionError("监控状态已更新，请刷新。");
  if (watch.pauseReason === "replaced" || !isCurrent())
    throw new SupervisionError("监控目标已变化。");
  if (request.action === "resume") {
    if (
      watch.continuationCount >= 3 ||
      watch.pauseReason === "continuation_limit"
    )
      throw new SupervisionError("已达三次续接上限，请明确重新开启一轮监控。");
    if (watch.outcome === "completed")
      throw new SupervisionError("已完成的监控需要重新开启一轮。");
    if (
      watch.decisions.some(
        (decision) =>
          decision.delivery === "offered" || decision.delivery === "unknown",
      )
    )
      throw new SupervisionError(
        "续接投递尚未确认；请检查原终端，不重复发送。",
      );
    const source = messagesFrom(await readHistory());
    if (!isCurrent()) throw new SupervisionError("监控目标已变化。");
    watch.lastFinalMessageId =
      latestFinalId(source) ?? watch.lastFinalMessageId;
    watch.status = "watching";
    delete watch.pauseReason;
  } else if (request.action === "pause") {
    watch.status = "paused";
    watch.pauseReason = "user_paused";
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
}
