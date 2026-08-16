import type { AgentTeamRun } from "@runweave/shared/agent-team";

export function ReviewCheckpointStatus({ run }: { run: AgentTeamRun }) {
  const checkpoint = run.reviewCheckpoint;
  if (!checkpoint) {
    return null;
  }
  const target = checkpoint.pendingReview;
  const latest = checkpoint.checkpoints.at(-1) ?? null;
  const shortSha = (value: string) => value.slice(0, 8);
  return (
    <div className="space-y-1 rounded border border-sky-900 bg-sky-950/20 p-2 text-[10px] text-slate-400">
      <div className="flex items-center justify-between">
        <span className="font-semibold uppercase text-sky-300">
          Review Checkpoint
        </span>
        <span>{latest ? `C${latest.sequence}` : "等待首次 review"}</span>
      </div>
      <div className="break-all">分支：{checkpoint.branch}</div>
      <div>任务基线：{shortSha(checkpoint.taskBaseCommit)}</div>
      <div>
        最新 checkpoint：
        {latest ? shortSha(latest.commit) : "尚未创建"}
      </div>
      {target ? (
        <div className="rounded border border-sky-900/70 bg-slate-950/40 p-1.5">
          <div>
            当前审查：{target.scope} · {shortSha(target.baseCommit)} → tree{" "}
            {shortSha(target.targetTree)}
          </div>
          <div>影响文件：{target.changedPaths.length}</div>
        </div>
      ) : null}
      {checkpoint.finalReviewedCommit ? (
        <div>最终全量 review：{shortSha(checkpoint.finalReviewedCommit)}</div>
      ) : null}
      <div className="text-slate-500">
        本地 checkpoint 仅表示代码审查基线，不代表行为验收或发布完成。
      </div>
    </div>
  );
}
