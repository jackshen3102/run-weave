import type { TaskWatch } from "@runweave/shared/task-supervision";
import { currentSupervisionDecisions } from "@runweave/shared/task-supervision";

export function taskSupervisionStatus(watch: TaskWatch) {
  if (!watch.enabled) return "监控已关闭";
  if (watch.status === "watching" && watch.waitingFor)
    return watch.waitingFor === "permission"
      ? "等待你在原终端批准权限"
      : "等待你在原终端回答问题";
  if (watch.pauseReason === "continuation_limit")
    return "已达续接上限 · 任务仍未完成";
  if (watch.pauseReason === "delivery_unknown") return "续接待确认";
  if (watch.status === "error") return currentSupervisionDecisions(watch).at(-1)?.deliveryBlock === "draft_unconfirmed"
    ? "任务可以继续 · 自动续接未发送" : "监听异常 / 上下文待补充";
  if (watch.status === "paused") return "监控已暂停";
  if (watch.status === "classifying") return "正在判断任务状态";
  if (watch.taskStartMessageId.startsWith("pending:"))
    return "等待新任务 · 终端监听已开启";
  if (watch.status === "watching" && watch.outcome === "completed")
    return "本轮任务已完成 · 继续监听此终端";
  if (watch.status === "watching" && watch.outcome === "blocked")
    return "本轮需要你处理 · 继续监听此终端";
  if (watch.status === "ended")
    return watch.outcome === "completed" ? "目标已达成" : "需要你处理";
  return "正在监听最终回复";
}

export function taskSupervisionNeedsAttention(watch: TaskWatch) {
  return (
    watch.waitingFor != null ||
    watch.status === "error" ||
    watch.status === "paused" ||
    watch.pauseReason === "continuation_limit" ||
    watch.pauseReason === "delivery_unknown" ||
    watch.outcome === "blocked"
  );
}
