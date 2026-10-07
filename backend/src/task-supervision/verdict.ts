import type {
  SupervisionDecision,
  SupervisionHookResponse,
  TaskWatch,
} from "@runweave/shared/task-supervision";
const CONTINUATION =
  "请对照当前任务、计划和用户后续修改，说明还有哪些没完成、遇到了什么问题；能在现有授权内继续的，请继续实现、测试、验收或修复。不要重复已完成的工作。结束本轮时说明已完成项、剩余项，以及是否需要用户提供信息或权限。";
/** Called only inside the persisted revision fence. Reserve an offer before returning it. */
export function applyVerdict(
  watch: TaskWatch,
  decision: SupervisionDecision,
): SupervisionHookResponse {
  watch.decisions.push(decision);
  watch.outcome = decision.outcome;
  watch.revision++;
  watch.updatedAt = decision.createdAt;
  if (decision.outcome !== "continue") {
    watch.status = "ended";
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
