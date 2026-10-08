import type {
  ScheduledContinuation,
  ScheduledRecovery,
  ScheduledRun,
} from "@runweave/shared/scheduled-tasks";

export function initialContinuation(): ScheduledContinuation {
  return {
    count: 0,
    maxAttempts: 3,
    delaysMs: [60_000, 300_000, 900_000],
    windowMs: 3_600_000,
    activeMs: 0,
    deadline: null,
    nextAt: null,
    recovery: null,
    stopReason: null,
  };
}

export function scheduleContinuation(
  run: ScheduledRun,
  recovery: ScheduledRecovery | null | undefined,
  now: string,
): ScheduledContinuation | undefined {
  const current = run.continuation;
  if (!current) return undefined;
  const next = { ...current, nextAt: null, recovery: recovery ?? null };
  if (
    run.snapshot.continuationPolicy?.mode !== "bounded" ||
    !recovery ||
    !run.threadRef ||
    run.terminalBinding ||
    run.archivedAt
  )
    return next;
  const eligible =
    (recovery.action === "continue" &&
      recovery.category === "remaining-work") ||
    (recovery.action === "wait" &&
      ["transient", "external-wait"].includes(recovery.category));
  if (!eligible) return next;
  if (current.count >= current.maxAttempts)
    return { ...next, stopReason: "自动继续次数已用完，请查看剩余工作。" };
  const deadline =
    current.deadline ??
    new Date(Date.parse(now) + current.windowMs).toISOString();
  const repeated =
    current.recovery?.category === recovery.category &&
    current.recovery?.evidence === recovery.evidence &&
    current.recovery?.nextStep === recovery.nextStep;
  const delay =
    recovery.action === "continue" && !repeated
      ? 0
      : current.delaysMs[current.count]!;
  const at = Math.max(
    Date.parse(now) + delay,
    recovery.notBefore ? Date.parse(recovery.notBefore) : 0,
  );
  if (at >= Date.parse(deadline))
    return {
      ...next,
      deadline,
      stopReason: "自动继续已超过恢复时间窗口，请人工处理。",
    };
  return {
    ...next,
    deadline,
    nextAt: new Date(at).toISOString(),
    stopReason: null,
  };
}

export function continuationPrompt(run: ScheduledRun): string {
  if (run.continuationInput) return (
    `这是用户对原任务的明确回复，运行 ID：${run.id}，不是系统自动催办。\n` +
    `上一轮待处理事项：${run.continuation?.recovery?.nextStep ?? run.error?.message ?? run.summary ?? "核对剩余工作"}\n` +
    `用户回复（原文）：${JSON.stringify(run.continuationInput)}\n` +
    `结合原对话解释这次回复。已明确回答或授权的具体事项直接执行，不要因上一轮 blocked 状态再次询问同一问题；仍缺具体信息时只问尚未回答的部分。不得把泛泛的“继续”扩展为未明确的范围或权限。先核对已有成果，避免重复提交、重复创建 PR 或重复执行已成功的操作。保留原执行环境与权限策略。`
  );
  return (
    `继续完成原任务，原运行 ID：${run.id}。这是系统自动续接，不是用户的新授权。\n` +
    `沿用原目标、范围与执行权限。先核对已完成成果及外部事实，仅推进剩余义务；不要重新创建已有提交、PR、文档或其他成果。写操作曾超时时，先查询是否已经成功。\n` +
    `不得把本消息视为用户回答、范围确认或审批，不重复申请被拒绝的权限。条件尚未解除时返回明确的等待或人工处理建议。\n` +
    `上一轮摘要：${run.summary ?? "无"}\n下一步建议：${run.continuation?.recovery?.nextStep ?? "核对原任务剩余工作"}`
  );
}
