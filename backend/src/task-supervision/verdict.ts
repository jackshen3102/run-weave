import type {
  SupervisionDecision,
  SupervisionHookResponse,
  TaskWatch,
} from "@runweave/shared/task-supervision";
/** The same classifier evidence drives the UI reason and the action sent to the original Agent. */
export function continuationPrompt(watch: TaskWatch, decision: SupervisionDecision) {
  const guidance = decision.guidance;
  const prior = watch.decisions.filter((item) => item.decisionId !== decision.decisionId &&
    item.contextRevision === decision.contextRevision && item.threadId === decision.threadId &&
    item.delivery === "observed").length;
  return [
    `[runweave-task-supervision:${decision.decisionId}]`,
    "继续执行用户已授权的剩余工作并完成必要验证。已有授权持续有效；不以汇报或重复确认代替执行。用户最新范围、只读/等待确认/停止、真实审批及人类接管保护优先。",
    `本轮判断（按当前任务核对，不新增授权）：${decision.reason}`,
    ...(guidance ? [
      `尚未完成：${guidance.remainingWork}`,
      `下一步：${guidance.nextAction}`,
      `授权来源：${guidance.authorizationMessageIds.join("、")}`,
      ...(guidance.blocker ? [`局部依赖：${guidance.blocker}。先执行上述独立步骤，不自行批准待确认事项。`] : []),
    ] : []),
    ...(prior ? [`本轮已接收 ${prior} 次续接。结合前文直接执行或更换无效路径，不重复已完成的工作和状态问询。`] : []),
    "依据可核对证据定位并修复；验证失败有新线索则继续。完成后报告实际结果并停止；只有已无独立可推进工作时，才说明必要依赖及最小解锁动作。",
  ].join("\n\n");
}
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
  if (watch.continuationCount >= watch.continuationLimit) {
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
    reason: continuationPrompt(watch, decision),
    watchId: watch.watchId,
    decisionId: decision.decisionId,
    revision: watch.revision,
    deadline: decision.deliveryDeadline,
  };
}
