import type {
  SupervisionDecision,
  SupervisionHookResponse,
  TaskWatch,
} from "@runweave/shared/task-supervision";
const CONTINUATION =
  "请对照当前任务、计划和用户最新要求，说明已完成项、剩余项、复现与验收情况及阻塞。\n\n对于疑似问题，遵循先复现、再解决；未复现不得修改代码，应说明尝试条件、结果和缺少的信息。没有新线索时，不重复相同尝试。本提醒仅用于问询进展，不构成新增任务或修复授权，不得扩大范围或重复已完成工作。\n\n结束本轮时说明需要用户补充的信息或权限。";
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
  if (!canDeliver) {
    watch.status = "error";
    watch.error = "终端有用户输入尚未提交；保留草稿，等待下一轮回复。";
    return { action: "allow-stop" };
  }
  if (watch.continuationCount === 3) {
    watch.status = "paused";
    watch.pauseReason = "continuation_limit";
    return { action: "allow-stop" };
  }
  watch.continuationCount++;
  decision.delivery = "offered";
  watch.status = "watching";
  return {
    action: "request-continuation",
    reason: `[runweave-task-supervision:${decision.decisionId}]\n${CONTINUATION}`,
    watchId: watch.watchId,
    decisionId: decision.decisionId,
    revision: watch.revision,
    deadline: decision.deliveryDeadline,
  };
}
