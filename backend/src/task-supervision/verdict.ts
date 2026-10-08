import type {
  SupervisionDecision,
  SupervisionHookResponse,
  TaskWatch,
} from "@runweave/shared/task-supervision";
const CONTINUATION =
  "以完成当前授权任务并验证结果为目标，依据当前上下文主动判断并执行下一步，不以进度汇报、建议或交回问题代替完成。\n\n将真正需要确认的事项标为待确认，同时完成可独立推进的工作；不重复询问已确定的事项。任务范围内的疑似缺陷先复现，确认后修复并验证；验证失败则继续定位处理，没有新线索不重复相同尝试。\n\n仅在确实无法自行解决时请求具体帮助，说明缺少什么及影响；不得扩大任务范围、虚构用户授权或绕过权限与人类接管保护。任务和必要验证完成后停止，不重复工作或空转。";
/** Called only inside the persisted revision fence. Reserve an offer before returning it. */
export function applyVerdict(
  watch: TaskWatch,
  decision: SupervisionDecision,
  canDeliver = true,
): SupervisionHookResponse {
  watch.decisions.push(decision);
  watch.outcome = decision.outcome;
  watch.revision++;
  watch.updatedAt = decision.createdAt;
  if (decision.outcome !== "continue") {
    watch.status = "watching";
    return { action: "allow-stop" };
  }
  return reserveContinuation(watch, decision, canDeliver);
}

export function reserveContinuation(watch: TaskWatch, decision: SupervisionDecision, canDeliver = true): SupervisionHookResponse {
  if (!canDeliver) {
    watch.status = "error";
    decision.deliveryBlock = "draft_unconfirmed";
    watch.error = "无法确认原终端输入框是否为空，自动续接未发送。请检查原终端；确认没有草稿后可重试。";
    return { action: "allow-stop" };
  }
  if (watch.continuationCount === 3) {
    watch.status = "paused";
    watch.pauseReason = "continuation_limit";
    return { action: "allow-stop" };
  }
  watch.continuationCount++;
  delete decision.deliveryBlock;
  delete watch.error;
  delete watch.pauseReason;
  decision.deliveryDeadline = Date.now() + 30_000;
  decision.delivery = "offered";
  watch.status = "watching";
  return {
    action: "request-continuation",
    reason: `[runweave-task-supervision:${decision.decisionId}]\n${CONTINUATION}\n\n本轮上下文判断（不构成新增授权，按当前任务核对后执行）：\n${decision.reason}`,
    watchId: watch.watchId,
    decisionId: decision.decisionId,
    revision: watch.revision,
    deadline: decision.deliveryDeadline,
  };
}
