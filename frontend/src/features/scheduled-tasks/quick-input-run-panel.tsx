import { useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import type { ScheduledRun } from "@runweave/shared/scheduled-tasks";
import { resolveTerminalParentProjectId } from "@runweave/shared/terminal/project-context";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  Clock,
  Play,
} from "lucide-react";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import {
  createTerminalSession,
  getTerminalSession,
  listTerminalProjectContexts,
} from "../../services/terminal";
import { terminalQueryKeys } from "../terminal/queries/keys";
import { useTerminalRuntime } from "../terminal/queries/provider";
import { setTerminalNavigation } from "../terminal/state/navigation";
import { useOpenRun } from "./open-run";
import { useRun, useScheduledApi } from "./queries";
import {
  displayTime,
  displayDuration,
  executionPolicyLabel,
  RequestError,
  safeArtifactUrl,
} from "./presentation";
import { RunProgress } from "./run-progress";
import { RunSummary } from "./run-summary";
import {
  canArchiveQuickInputRun,
  isQuickInputRunActive,
  quickInputRunLabel,
  quickInputRunNeedsAttention,
  quickInputRunProjectLabel,
} from "./use-quick-input-background-runs";

export function QuickInputRunRow({
  run,
  onSelect,
}: {
  run: ScheduledRun;
  onSelect: () => void;
}) {
  const attention = quickInputRunNeedsAttention(run);
  const Icon = attention
    ? AlertTriangle
    : run.status === "queued"
      ? Clock
      : Play;
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid={`quick-command-run-${run.id}`}
      className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left ${attention ? "border-orange-500/30 bg-orange-500/5" : "border-slate-800 bg-slate-900/60"}`}
    >
      <Icon
        className={`h-4 w-4 shrink-0 ${attention ? "text-orange-300" : "text-sky-300"}`}
      />
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium">
            {run.snapshot.name}
          </span>
          <span
            className={`shrink-0 text-xs ${attention ? "text-orange-300" : "text-sky-300"}`}
          >
            {quickInputRunLabel(run)}
            {run.status === "running" && run.startedAt
              ? ` · ${displayDuration(Date.now() - Date.parse(run.startedAt))}`
              : ""}
          </span>
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {quickInputRunProjectLabel(run)}
        </span>
        {attention ? (
          <span className="block truncate text-xs text-orange-300">
            {run.error?.message ?? "点按查看原因与输出"}
          </span>
        ) : null}
      </span>
      <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
    </button>
  );
}

export function QuickInputRunPanel({
  open,
  onOpenChange,
  selectedRun,
  onSelect,
  dashboardRuns,
  historyRuns,
  loading,
  error,
  onRefresh,
  onUpdate,
  onOpened,
  connectionName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedRun: ScheduledRun | null;
  onSelect: (run: ScheduledRun | null) => void;
  dashboardRuns: ScheduledRun[];
  historyRuns: ScheduledRun[];
  loading: boolean;
  error: unknown;
  onRefresh: () => void;
  onUpdate: (run: ScheduledRun) => void;
  onOpened: () => void;
  connectionName: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[85vh] max-w-2xl flex-col overflow-hidden"
        data-testid="quick-command-runs-panel"
      >
        <DialogHeader>
          {selectedRun ? (
            <Button
              variant="ghost"
              size="sm"
              className="mb-2 w-fit gap-1 pl-0"
              onClick={() => onSelect(null)}
            >
              <ArrowLeft className="h-4 w-4" />
              后台任务
            </Button>
          ) : null}
          <DialogTitle>{selectedRun ? "运行详情" : "后台任务"}</DialogTitle>
          <DialogDescription>{connectionName} · 所有项目</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto pr-1">
          {selectedRun ? (
            <QuickInputRunDetail
              key={selectedRun.id}
              initial={selectedRun}
              onUpdate={onUpdate}
              onOpened={onOpened}
            />
          ) : (
            <div className="space-y-3">
              <RequestError error={error} />
              <Button variant="ghost" size="sm" onClick={onRefresh}>
                刷新任务
              </Button>
              {loading ? (
                <p className="text-sm text-muted-foreground">正在读取…</p>
              ) : !dashboardRuns.length && !error ? (
                <p className="text-sm text-muted-foreground">暂无后台任务</p>
              ) : null}
              {dashboardRuns.map((run) => (
                <QuickInputRunRow
                  key={run.id}
                  run={run}
                  onSelect={() => onSelect(run)}
                />
              ))}
              <h3 className="pt-4 text-sm font-medium text-muted-foreground">
                历史记录
              </h3>
              {!historyRuns.length && !loading && !error ? (
                <p className="text-sm text-muted-foreground">暂无历史记录</p>
              ) : null}
              {historyRuns.map((run) => (
                <QuickInputRunRow
                  key={run.id}
                  run={run}
                  onSelect={() => onSelect(run)}
                />
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function QuickInputRunDetail({
  initial,
  onUpdate,
  onOpened,
}: {
  initial: ScheduledRun;
  onUpdate: (run: ScheduledRun) => void;
  onOpened: () => void;
}) {
  const current = useRun(initial.id);
  const run = current.data ?? initial;
  const open = useOpenRun();
  const { api } = useScheduledApi();
  const { apiBase, token, scope } = useTerminalRuntime();
  const client = useQueryClient();
  const navigate = useNavigate();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const active = isQuickInputRunActive(run);
  const ownerUnresolved =
    run.status === "waiting" && run.error?.code === "owner_unresolved";
  const canOpen = !active && run.recoverable && Boolean(run.threadRef);
  const create = useMutation({
    mutationFn: async () => {
      const parentProjectId = resolveTerminalParentProjectId(
        run.executionProjectId,
      );
      const contexts = await listTerminalProjectContexts(
        apiBase,
        token,
        parentProjectId,
      );
      if (!mounted.current) throw new Error("页面已离开");
      if (
        !contexts.some(
          (context) =>
            context.projectId === run.executionProjectId &&
            context.path === run.cwd &&
            context.availability === "available",
        )
      )
        throw new Error("本次运行的项目或工作区已不可用，无法新建终端。");
      const created = await createTerminalSession(apiBase, token, {
        projectId: run.executionProjectId,
      });
      const details = await getTerminalSession(
        apiBase,
        token,
        created.terminalSessionId,
      );
      if (
        details.projectId !== run.executionProjectId ||
        details.cwd !== run.cwd
      )
        throw new Error("项目执行位置已变化，请重新确认后再打开终端。");
      await client.invalidateQueries({
        queryKey: terminalQueryKeys.all(scope),
      });
      if (!mounted.current) return;
      setTerminalNavigation(scope, {
        parentProjectId,
        projectId: run.executionProjectId,
        terminalSessionId: created.terminalSessionId,
      });
      onOpened();
      navigate(`/terminal/${encodeURIComponent(created.terminalSessionId)}`);
    },
  });
  const archive = useMutation({
    mutationFn: () => api.archive(run.id),
    onSuccess: (updated) => {
      onUpdate(updated);
      void current.refetch();
    },
  });
  const opening = open.isPending || create.isPending;
  return (
    <div className="space-y-4" data-testid="quick-command-run-detail">
      <h3 className="break-words text-xl font-semibold">{run.snapshot.name}</h3>
      <p className="text-xs text-muted-foreground">
        {quickInputRunProjectLabel(run)} ·{" "}
        {displayTime(run.startedAt ?? run.scheduledFor)}
      </p>
      <p
        className={`rounded-xl bg-muted p-3 text-sm ${quickInputRunNeedsAttention(run) ? "text-orange-400" : "text-primary"}`}
      >
        {quickInputRunLabel(run)}
      </p>
      <RequestError error={current.error} />
      {run.summary ? <RunSummary text={run.summary} /> : null}
      {run.error ? (
        <p className="break-words text-sm text-orange-400">
          {run.error.message}
        </p>
      ) : null}
      {active || ownerUnresolved ? (
        <p className="text-xs text-muted-foreground">
          {ownerUnresolved
            ? "原执行进程尚未确认退出，暂时不能恢复对话。"
            : "运行结束后可打开对话；运行期间可在下方查看输出。"}
        </p>
      ) : (
        <div className="space-y-2">
          {!canOpen ? (
            <p className="text-xs text-muted-foreground">
              本次运行没有可恢复的对话。可在相同项目和工作区新建终端查看问题，运行输出仍保留在此处。
            </p>
          ) : null}
          <Button
            className="w-full"
            disabled={opening || archive.isPending}
            onClick={() => {
              if (canOpen) open.mutate(run.id, { onSuccess: onOpened });
              else create.mutate();
            }}
          >
            {opening
              ? "正在打开…"
              : canOpen
                ? "打开对话并继续追问"
                : "新建项目终端"}
          </Button>
        </div>
      )}
      <RequestError error={open.error ?? create.error} />
      <div className="space-y-2">
        {run.artifacts.map((artifact, index) => {
          const url = safeArtifactUrl(artifact.url);
          return url ? (
            <a
              key={index}
              className="block break-all text-sm text-primary underline"
              href={url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {artifact.label}
            </a>
          ) : (
            <p key={index} className="whitespace-pre-wrap break-words text-sm">
              {artifact.label}
              {artifact.text ? `：${artifact.text}` : ""}
            </p>
          );
        })}
      </div>
      <section>
        <h4 className="text-sm text-muted-foreground">运行输出</h4>
        <RunProgress run={run} />
      </section>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">本次执行配置</summary>
        <p className="mt-2">
          {run.snapshot.model || "默认模型"} ·{" "}
          {run.snapshot.effort || "默认推理"} ·{" "}
          {executionPolicyLabel(run.snapshot.executionPolicy)}
        </p>
        <p className="mt-2 whitespace-pre-wrap break-words">
          {run.snapshot.prompt}
        </p>
      </details>
      {canArchiveQuickInputRun(run) ? (
        <div className="space-y-2">
          <Button
            variant="outline"
            className="w-full"
            disabled={archive.isPending || opening}
            onClick={() => archive.mutate()}
          >
            {archive.isPending ? "正在移至历史…" : "移至历史"}
          </Button>
          <p className="text-xs text-muted-foreground">
            从主列表移走，执行结果和输出保留在历史记录中。
          </p>
        </div>
      ) : run.archivedAt ? (
        <p className="text-xs text-muted-foreground">已移至历史</p>
      ) : null}
      <RequestError error={archive.error} />
    </div>
  );
}
