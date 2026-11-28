import { useEffect, useState } from "react";
import { useMemoizedFn } from "ahooks";
import type {
  BatchCleanupWorktreesResponse,
  WorktreeGovernanceBucket,
  WorktreeGovernanceItem,
  WorktreeGovernanceResponse,
} from "@runweave/shared/terminal/project-context";
import { Pin, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import {
  batchCleanupWorktrees,
  getWorktreeGovernance,
} from "../../../services/terminal/projects";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "../../ui/dialog";
import { Button } from "../../ui/button";

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "估算中…";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function bucketMeta(bucket: WorktreeGovernanceBucket): {
  label: string;
  className: string;
} {
  switch (bucket) {
    case "pinned":
      return {
        label: "已置顶保护",
        className: "border-sky-500/40 bg-sky-500/15 text-sky-300",
      };
    case "active":
      return {
        label: "活跃保护",
        className: "border-slate-600 bg-slate-800 text-slate-300",
      };
    case "dirty_abandoned":
      return {
        label: "有未提交改动",
        className: "border-amber-500/40 bg-amber-500/15 text-amber-200",
      };
    case "idle_hot_slot":
      return {
        label: "空闲热槽位",
        className: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300",
      };
    case "cleanable_merged":
      return {
        label: "已合并可清理",
        className: "border-emerald-500/40 bg-emerald-500/15 text-emerald-200",
      };
    case "cleanable_stale":
      return {
        label: "久置可清理",
        className: "border-violet-500/40 bg-violet-500/15 text-violet-200",
      };
  }
}

export function WorktreeGovernanceDialog({
  apiBase,
  token,
  parentProjectId,
  onClose,
  onCompleted,
  onRecycleItem,
}: {
  apiBase: string;
  token: string;
  parentProjectId: string;
  onClose: () => void;
  onCompleted: (response: BatchCleanupWorktreesResponse) => void;
  onRecycleItem: (childProjectId: string) => void;
}) {
  const [data, setData] = useState<WorktreeGovernanceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [diskLoading, setDiskLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [forceConfirmedIds, setForceConfirmedIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [expandedDirtyIds, setExpandedDirtyIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [deleteBranches, setDeleteBranches] = useState(true);
  const [pruneMetadata, setPruneMetadata] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] =
    useState<BatchCleanupWorktreesResponse | null>(null);

  const load = useMemoizedFn(async () => {
    setLoading(true);
    setError(null);
    try {
      const fast = await getWorktreeGovernance(
        apiBase,
        token,
        parentProjectId,
        false,
      );
      setData(fast);
      const defaults = new Set<string>();
      for (const item of fast.items) {
        if (item.bucket === "cleanable_merged" && item.canSafeDelete) {
          defaults.add(item.projectId);
        }
      }
      setSelectedIds(defaults);
      setForceConfirmedIds(new Set());
      setLoading(false);

      setDiskLoading(true);
      try {
        const withDisk = await getWorktreeGovernance(
          apiBase,
          token,
          parentProjectId,
          true,
        );
        setData(withDisk);
      } finally {
        setDiskLoading(false);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setLoading(false);
    }
  });

  useEffect(() => {
    void load();
  }, [parentProjectId, load]);

  const toggleSelect = useMemoizedFn((item: WorktreeGovernanceItem) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(item.projectId)) {
        next.delete(item.projectId);
      } else {
        next.add(item.projectId);
      }
      return next;
    });
  });

  const toggleForceConfirm = useMemoizedFn((projectId: string) => {
    setForceConfirmedIds((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
        setSelectedIds((sel) => {
          const updated = new Set(sel);
          updated.delete(projectId);
          return updated;
        });
      } else {
        next.add(projectId);
        setSelectedIds((sel) => new Set(sel).add(projectId));
      }
      return next;
    });
  });

  const toggleDirtyExpand = useMemoizedFn((projectId: string) => {
    setExpandedDirtyIds((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  });

  const selectAllCleanable = useMemoizedFn(() => {
    if (!data) return;
    const next = new Set<string>();
    for (const item of data.items) {
      if (item.canSafeDelete) next.add(item.projectId);
    }
    setSelectedIds(next);
  });

  const runCleanup = useMemoizedFn(async () => {
    if (submitting || !data) return;
    const childProjectIds = Array.from(selectedIds);
    const shouldPrune = pruneMetadata && data.prunable.length > 0;
    if (childProjectIds.length === 0 && !shouldPrune) return;

    setSubmitting(true);
    setError(null);
    try {
      const response = await batchCleanupWorktrees(
        apiBase,
        token,
        parentProjectId,
        {
          operationId: crypto.randomUUID(),
          childProjectIds,
          forceConfirmedProjectIds: Array.from(forceConfirmedIds).filter((id) =>
            selectedIds.has(id),
          ),
          deleteMergedLocalBranches: deleteBranches,
          pruneMetadata: shouldPrune,
        },
      );
      setLastResult(response);
      onCompleted(response);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSubmitting(false);
    }
  });

  const items = data?.items ?? [];
  const cleanableCount = items.filter((item) => item.canSafeDelete).length;
  const selectedDiskBytes = items
    .filter((item) => selectedIds.has(item.projectId))
    .reduce((sum, item) => sum + (item.diskUsageBytes ?? 0), 0);
  const canSubmit =
    !submitting &&
    Boolean(data) &&
    (selectedIds.size > 0 || (pruneMetadata && (data?.prunable.length ?? 0) > 0));

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting) onClose();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        className="max-h-[90vh] max-w-2xl overflow-auto"
      >
        <div className="flex items-center justify-between gap-2">
          <DialogTitle>整理 Worktree</DialogTitle>
          <div className="flex items-center gap-2">
            {cleanableCount > 0 ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={submitting || loading}
                onClick={selectAllCleanable}
              >
                全选安全可清理（含热槽位）
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={submitting || loading}
              onClick={() => void load()}
              aria-label="刷新 Worktree 状态"
            >
              <RefreshCw
                className={[
                  "h-3.5 w-3.5",
                  loading || diskLoading ? "animate-spin" : "",
                ].join(" ")}
              />
            </Button>
          </div>
        </div>

        {loading && !data ? (
          <p className="py-6 text-center text-xs text-slate-400">
            正在扫描 Worktree 状态…
          </p>
        ) : null}

        {data ? (
          <div className="grid gap-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-800 bg-slate-900/70 px-3 py-2 text-slate-300">
              <span>
                基准分支：<code>{data.baseRef ?? "无法解析"}</code> · 共{" "}
                {items.length} 个子 Worktree · 可安全清理 {cleanableCount} 个
              </span>
              <span className="text-slate-400">
                已选 {selectedIds.size} 项
                {selectedDiskBytes > 0
                  ? `（预计释放 ~${formatBytes(selectedDiskBytes)}）`
                  : ""}
              </span>
            </div>

            {items.length === 0 ? (
              <p className="py-4 text-center text-slate-400">
                当前项目下没有子 Worktree。
              </p>
            ) : (
              <div className="grid gap-2">
                {items.map((item) => {
                  const meta = bucketMeta(item.bucket);
                  const checked = selectedIds.has(item.projectId);
                  const forceConfirmed = forceConfirmedIds.has(item.projectId);
                  const dirtyExpanded = expandedDirtyIds.has(item.projectId);
                  const checkboxDisabled =
                    submitting ||
                    (!item.canSafeDelete &&
                      !(item.canForceDeleteWithConfirm && forceConfirmed));

                  return (
                    <div
                      key={item.projectId}
                      data-testid="worktree-governance-row"
                      data-project-id={item.projectId}
                      data-bucket={item.bucket}
                      className="rounded-md border border-slate-800 bg-slate-950/80 p-2.5"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <label className="flex min-w-0 flex-1 items-start gap-2">
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={checked}
                            disabled={checkboxDisabled}
                            onChange={() => toggleSelect(item)}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-1.5">
                              {item.pinned ? (
                                <Pin className="h-3 w-3 shrink-0 fill-current text-sky-400" />
                              ) : null}
                              <strong className="truncate text-slate-100">
                                {item.name}
                              </strong>
                              <span
                                className={[
                                  "rounded border px-1.5 py-0.5 text-[10px]",
                                  meta.className,
                                ].join(" ")}
                              >
                                {meta.label}
                              </span>
                              <span className="text-slate-400">
                                {item.branch ?? "detached HEAD"}
                              </span>
                            </span>
                            <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-slate-400">
                              <span>
                                体积：
                                {diskLoading && item.diskUsageBytes === null
                                  ? "估算中…"
                                  : item.diskUsageBytes === null
                                    ? "—"
                                    : formatBytes(item.diskUsageBytes)}
                              </span>
                              <span>终端：{item.terminalCount}</span>
                              {item.runningAgentCount > 0 ? (
                                <span className="text-amber-300">
                                  {item.runningAgentCount} 个 Agent 运行中
                                </span>
                              ) : null}
                              {item.mergedIntoBase === true ? (
                                <span className="text-emerald-400">
                                  已合入主分支
                                </span>
                              ) : item.mergedIntoBase === false ? (
                                <span>未合入主分支</span>
                              ) : null}
                            </span>
                            {item.blockReason ? (
                              <span className="mt-0.5 block text-[11px] text-slate-500">
                                {item.blockReason}
                              </span>
                            ) : null}
                          </span>
                        </label>
                        {item.canRecycle ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={submitting}
                            className="h-7 shrink-0 gap-1 px-2 text-xs text-sky-400"
                            onClick={() => onRecycleItem(item.projectId)}
                          >
                            <RotateCcw className="h-3 w-3" />
                            原地复用
                          </Button>
                        ) : null}
                      </div>

                      {item.canForceDeleteWithConfirm ? (
                        <div className="mt-2 rounded border border-amber-500/30 bg-amber-500/5 p-2 text-[11px]">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-amber-200">
                              {item.changedFilesCount} 个已修改 /{" "}
                              {item.untrackedFilesCount} 个未跟踪文件
                            </span>
                            <button
                              type="button"
                              className="text-sky-400 hover:underline"
                              onClick={() => toggleDirtyExpand(item.projectId)}
                            >
                              {dirtyExpanded ? "收起文件清单" : "查看脏文件清单"}
                            </button>
                          </div>
                          {dirtyExpanded && item.dirtyPreviewFiles.length > 0 ? (
                            <ul className="mt-1.5 max-h-28 overflow-auto font-mono text-[10px] text-slate-300">
                              {item.dirtyPreviewFiles.map((file) => (
                                <li key={file}>{file}</li>
                              ))}
                            </ul>
                          ) : null}
                          <label className="mt-1.5 flex items-center gap-1.5 text-amber-200">
                            <input
                              type="checkbox"
                              checked={forceConfirmed}
                              disabled={submitting}
                              onChange={() =>
                                toggleForceConfirm(item.projectId)
                              }
                            />
                            确认丢弃以上未提交/未跟踪文件并强制移除此目录（不强删未合并本地分支）
                          </label>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}

            {data.prunable.length > 0 ? (
              <div className="rounded-md border border-slate-800 bg-slate-900/50 p-2.5">
                <div className="font-medium text-slate-200">
                  悬空 Git Worktree 元数据（{data.prunable.length} 条 `prunable`）
                </div>
                <ul className="mt-1 max-h-24 overflow-auto font-mono text-[10px] text-slate-400">
                  {data.prunable.map((entry) => (
                    <li key={entry.worktreePath}>
                      {entry.worktreePath}
                      {entry.branch ? ` [${entry.branch}]` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="grid gap-1.5 border-t border-slate-800 pt-2 text-slate-300">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={deleteBranches}
                  disabled={submitting}
                  onChange={(e) => setDeleteBranches(e.target.checked)}
                />
                顺带安全删除已合并的本地分支（仅执行 <code>git branch -d</code>）
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={pruneMetadata}
                  disabled={submitting}
                  onChange={(e) => setPruneMetadata(e.target.checked)}
                />
                执行 <code>git worktree prune</code> 清理悬空元数据（
                {data.prunable.length} 条）
              </label>
            </div>

            {lastResult ? (
              <div
                data-testid="worktree-governance-result"
                className="rounded-md border border-slate-700 bg-slate-900 p-2.5 text-[11px] text-slate-200"
              >
                <div>
                  本次清理完成：成功删除{" "}
                  {lastResult.results.filter((r) => r.status === "deleted").length}{" "}
                  个，失败{" "}
                  {lastResult.results.filter((r) => r.status === "failed").length}{" "}
                  个
                  {lastResult.prunedCount > 0
                    ? `，清理悬空元数据 ${lastResult.prunedCount} 条`
                    : ""}
                  。
                </div>
                {lastResult.results
                  .filter((r) => r.status === "failed")
                  .map((r) => (
                    <div key={r.childProjectId} className="mt-1 text-rose-400">
                      {r.childProjectId}：{r.message}
                    </div>
                  ))}
              </div>
            ) : null}

            {error ? (
              <p role="alert" className="text-rose-400">
                {error}
              </p>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={submitting}
            onClick={onClose}
          >
            关闭
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={!canSubmit}
            onClick={() => void runCleanup()}
            className="gap-1.5"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {submitting ? "清理中…" : "执行选中清理"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
