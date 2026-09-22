import { useEffect, useRef, useState } from "react";
import { useMemoizedFn } from "ahooks";
import { useSearchParams } from "react-router-dom";
import type {
  ScheduledRun,
  ScheduledTask,
} from "@runweave/shared/scheduled-tasks";
import { Button } from "../../components/ui/button";
import { useTask, useRuns, useRun } from "./queries";
import { TaskActions } from "./task-actions";
import {
  displayTime,
  RequestError,
  safeArtifactUrl,
  scheduleLabel,
  statusLabel,
} from "./presentation";
import { RunProgress } from "./run-progress";
import { useOpenRun } from "./open-run";
import { RunSummary } from "./run-summary";

function RunRecord({
  run,
  highlighted,
}: {
  run: ScheduledRun;
  highlighted: boolean;
}) {
  const [expanded, setExpanded] = useState(highlighted);
  const ref = useRef<HTMLElement>(null);
  const open = useOpenRun();
  const running = ["queued", "running", "stopping"].includes(run.status);
  const canOpen = !running && run.recoverable && Boolean(run.threadRef);
  const openRecord = useMemoizedFn(() => {
    if (canOpen) open.mutate(run.id);
    else setExpanded((value) => !value);
  });
  useEffect(() => {
    if (highlighted)
      ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [highlighted]);
  return (
    <article
      ref={ref}
      id={`run-${run.id}`}
      className={`min-w-0 scroll-m-6 rounded-xl border p-4 ${highlighted ? "border-primary ring-1 ring-primary" : "bg-card"}`}
    >
      <button
        type="button"
        className="w-full text-left"
        disabled={open.isPending}
        onClick={openRecord}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium">
            {displayTime(run.startedAt ?? run.scheduledFor)}
          </span>
          <span className="rounded-md bg-muted px-2 py-1 text-xs">
            {statusLabel[run.status]}
          </span>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {run.trigger === "manual" ? "手动运行" : "定时触发"} · 配置版本{" "}
          {run.taskRevision}
        </p>
      </button>
      {run.summary ? <RunSummary text={run.summary} /> : null}
      {run.error ? (
        <p className="mt-2 break-words text-sm text-destructive">
          {run.error.message} ({run.error.code})
        </p>
      ) : null}
      <button
        type="button"
        className="mt-3 text-left text-xs text-primary"
        disabled={open.isPending}
        onClick={openRecord}
      >
        {open.isPending
          ? open.attachmentState === "starting" ||
            open.attachmentState === "creating"
            ? "正在恢复对话…"
            : "正在打开…"
          : canOpen
            ? "打开对话并继续追问 →"
            : running
              ? "查看运行进度"
              : "查看记录"}
      </button>
      {run.terminalBinding?.attachmentState === "starting" ||
      run.terminalBinding?.attachmentState === "creating" ? (
        <p className="mt-2 text-xs text-muted-foreground">正在恢复对话…</p>
      ) : null}
      {run.terminalBinding?.attachmentState === "failed" ? (
        <p className="mt-2 text-xs text-destructive">
          {run.terminalBinding.error ?? "恢复失败"}
        </p>
      ) : null}
      <RequestError error={open.error} />
      <div className="mt-3 flex flex-wrap gap-3">
        {run.artifacts.map((artifact, index) => {
          const url = safeArtifactUrl(artifact.url);
          return url ? (
            <a
              key={index}
              className="break-all text-sm text-primary underline"
              href={url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {artifact.label}
            </a>
          ) : (
            <span
              key={index}
              className="whitespace-pre-wrap break-words text-sm"
            >
              {artifact.label}
              {artifact.text ? `：${artifact.text}` : ""}
            </span>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-start gap-3">
        <details className="min-w-0 flex-1 text-xs text-muted-foreground">
          <summary className="cursor-pointer">本次配置快照</summary>
          <p className="mt-2 break-words">
            {run.snapshot.name} · {run.snapshot.provider} ·{" "}
            {run.snapshot.projectId}
          </p>
          <p className="mt-1">{scheduleLabel(run.snapshot.schedule)}</p>
          <p className="mt-1">
            模型：{run.snapshot.model || "默认"} · 推理：
            {run.snapshot.effort || "默认"}
          </p>
          <p className="mt-2 whitespace-pre-wrap break-words">
            {run.snapshot.prompt}
          </p>
        </details>
        <button
          type="button"
          className="text-xs text-muted-foreground underline"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "收起输出" : "查看输出"}
        </button>
      </div>
      {expanded ? <RunProgress key={run.id} run={run} /> : null}
    </article>
  );
}
export function TaskDetail({
  taskId,
  onEdit,
  readOnly = false,
}: {
  taskId: string;
  readOnly?: boolean;
  onEdit: (task: ScheduledTask) => void;
}) {
  const task = useTask(taskId);
  const runs = useRuns(taskId);
  const [search] = useSearchParams();
  const targetId = search.get("run");
  const target = useRun(targetId);
  const history = runs.data?.pages.flatMap((page) => page.items) ?? [];
  // A deep link fetches its run independently of history pagination.
  const records =
    target.data?.taskId === taskId &&
    !history.some((run) => run.id === targetId)
      ? [target.data, ...history]
      : history;
  return (
    <div className="space-y-5">
      <RequestError error={task.error} />
      {task.isPending ? (
        <p>正在加载任务…</p>
      ) : task.data ? (
        <section className="rounded-xl border bg-card p-5">
          <div className="flex items-start justify-between gap-3">
            <h2 className="min-w-0 break-words text-xl font-semibold">
              {task.data.name}
            </h2>
            <TaskActions task={task.data} onEdit={onEdit} readOnly={readOnly} />
          </div>
          {task.data.deletedAt ? (
            <p className="mt-3 text-sm text-muted-foreground">
              此任务已删除。历史仍可查看和打开，调度不会恢复。
            </p>
          ) : null}
          <p className="mt-3 break-words text-sm text-muted-foreground">
            {task.data.projectId} · {task.data.provider}
          </p>
          <p className="mt-2 text-sm">{scheduleLabel(task.data.schedule)}</p>
          <p className="mt-2 text-sm text-muted-foreground">
            {task.data.enabled
              ? `下次运行：${displayTime(task.data.nextRunAt, task.data.schedule.timezone)}`
              : "已暂停后续安排"}
          </p>
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer">任务提示词</summary>
            <p className="mt-2 whitespace-pre-wrap break-words">
              {task.data.prompt}
            </p>
          </details>
        </section>
      ) : null}
      <h3 className="font-semibold">运行历史</h3>
      <RequestError error={runs.error ?? target.error} />
      {target.data && target.data.taskId !== taskId ? (
        <p role="alert">此运行不属于当前任务。</p>
      ) : null}
      {runs.isPending ? (
        <p className="text-sm text-muted-foreground">正在加载历史…</p>
      ) : !runs.error && !records.length ? (
        <p className="text-sm text-muted-foreground">还没有运行记录。</p>
      ) : null}
      {records.map((run) => (
        <RunRecord
          key={run.id}
          run={
            target.data?.id === run.id && target.data.taskId === taskId
              ? target.data
              : run
          }
          highlighted={run.id === targetId}
        />
      ))}
      {runs.hasNextPage ? (
        <Button
          variant="outline"
          disabled={runs.isFetchingNextPage}
          onClick={() => {
            void runs.fetchNextPage();
          }}
        >
          加载更多记录
        </Button>
      ) : null}
    </div>
  );
}
