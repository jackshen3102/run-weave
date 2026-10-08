import type { ScheduledRun } from "./types";

/** Shared UI/server eligibility; terminal ownership and execution budgets remain authoritative. */
export function scheduledReplyUnavailable(run: ScheduledRun): string | null {
  if (run.archivedAt) return "本次运行已移至历史。";
  if (run.terminalBinding)
    return "原会话已由终端接管，后台不会同时启动第二个执行器。";
  if (!run.threadRef) return "没有可恢复的原会话，无法在后台继续。";
  if (!["failed", "cancelled"].includes(run.status) || run.activeAttemptId)
    return "本次运行不在等待回复或重试的状态。";
  if (
    run.executionBudget &&
    ((run.continuation?.activeMs ?? 0) >= run.executionBudget.timeoutMs ||
      Number(run.outputCursor ?? 0) >= run.executionBudget.maxOutputBytes)
  )
    return "本次运行的累计执行或输出额度已用完。";
  return null;
}

export function scheduledRecoveryNotice(run: ScheduledRun): string | null {
  if (["queued", "running", "stopping"].includes(run.status))
    return run.continuationInput ? "已收到你的回复，正在继续处理。" : null;
  if (run.terminalBinding) return "已由终端接管，自动重试已停止。";
  if (run.continuation?.nextAt) return null;
  if (run.continuation?.stopReason) return run.continuation.stopReason;
  const recovery = run.continuation?.recovery;
  if (recovery?.action === "needs-input")
    return "等待你的回复；自动重试不能代替你的回答或授权。";
  if (["failed", "cancelled"].includes(run.status))
    return run.snapshot.continuationPolicy?.mode !== "bounded"
      ? "自动重试未开启，可在此回复后继续原会话。"
      : "没有可安全自动重试的条件，可在此回复或主动重试。";
  return null;
}
