import type { TerminalProjectContextBranchStatus } from "@runweave/shared/terminal/project-context";
import { isWorktreeBranchStatusStale } from "../../../features/terminal/queries/branch-status";

export function WorktreeBranchStatus({ status, failed }: {
  status?: TerminalProjectContextBranchStatus;
  failed: boolean;
}) {
  if (status?.state === "not-repository") return null;
  const stale = !status || failed || isWorktreeBranchStatusStale(status);
  const hasCount = status?.baseBranch !== undefined && status.behind !== undefined;
  const comparison = hasCount
    ? status.behind! > 0
      ? `落后 ${status.baseBranch} ${status.behind} 次提交`
      : `与 ${status.baseBranch} 无落差`
    : "分支状态待更新";
  const description = comparison + (stale && hasCount ? "，待更新" : "")
    + (status?.checkedAt ? `；上次更新：${new Date(status.checkedAt).toLocaleString()}` : "");
  return (
    <span
      data-testid="terminal-worktree-branch-status"
      aria-label={description}
      title={description}
      className={[
        "flex min-w-0 shrink-0 items-center gap-1 whitespace-nowrap text-[10px] tabular-nums",
        !stale && (status?.behind ?? 0) > 0 ? "text-amber-400" : "text-slate-500",
      ].join(" ")}
    >
      {hasCount ? <>
        <span className="max-w-12 truncate">{status.baseBranch}</span>
        <span>{status.behind! > 0 ? `↓${status.behind}` : "✓"}</span>
      </> : null}
      {stale ? <span>待更新</span> : null}
    </span>
  );
}
