import { useEffect, useRef, useState } from "react";
import { useMemoizedFn } from "ahooks";
import { useNavigate } from "react-router-dom";
import {
  Activity,
  ArrowLeft,
  AlertTriangle,
  Monitor,
  RefreshCw,
  Smartphone,
} from "lucide-react";
import type {
  DevResource,
  DevResourceGroup,
  DevResourcesSnapshot,
} from "@runweave/shared/dev-resources";
import { TerminalRuntimeProvider } from "../features/terminal/queries/provider";
import { TerminalWorktreeRail } from "../components/terminal/workspace/worktree-rail";
import { useTerminalRuntime } from "../features/terminal/queries/provider";
import {
  useTerminalSessionsQuery,
  EMPTY_TERMINAL_SESSIONS,
} from "../features/terminal/queries/workspace";
import { selectTerminalProjectContext } from "../components/terminal/workspace/effects";
import { useTerminalWorkspaceStore } from "../features/terminal/state/workspace-store";
import {
  ResourceList,
  stateLabels,
  timeLabel,
  type ResourceFilter,
} from "../features/dev-resources/resource-list";
import { getDevResources, releaseDevResource } from "../services/dev-resources";
import { HttpError } from "../services/http";
import { Button } from "../components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";

interface Props {
  apiBase: string;
  token: string;
  activeConnectionId: string | null;
  connectionGeneration?: number;
  connectionName?: string;
  onAuthExpired: () => void;
}

function Overview({
  title,
  group,
  simulator = false,
}: {
  title: string;
  group?: DevResourceGroup;
  simulator?: boolean;
}) {
  const counts = group?.counts;
  const unknown = !counts || counts.unknown === null || counts.unknown > 0;
  return (
    <section
      aria-label={`${title}总览`}
      className="rounded-lg border border-slate-800 bg-slate-900/70 p-5"
    >
      <p className="flex items-center gap-2 text-sm text-slate-400">
        {simulator ? (
          <Smartphone className="h-4 w-4" />
        ) : (
          <Monitor className="h-4 w-4" />
        )}
        {title}
      </p>
      <p className="my-4 flex items-baseline gap-2">
        <strong className="text-3xl font-semibold">
          {unknown || counts?.busy === null || counts?.blocked === null
            ? "—"
            : counts.busy + counts.blocked}
        </strong>
        <span className="text-lg text-slate-500">/ {counts?.total ?? "—"}</span>
        <span className="text-xs text-slate-400">已占用</span>
      </p>
      <div className="flex flex-wrap gap-4 text-xs text-slate-400">
        {(["busy", "blocked", "free", "unknown"] as const).map((state) => (
          <span key={state}>
            {stateLabels[state]} {counts?.[state] ?? "—"}
          </span>
        ))}
      </div>
    </section>
  );
}

function PageContent({ apiBase, token, connectionName, onAuthExpired }: Props) {
  const navigate = useNavigate();
  const { scope } = useTerminalRuntime();
  const sessions = useTerminalSessionsQuery().data ?? EMPTY_TERMINAL_SESSIONS;
  const selectProjectContext = useTerminalWorkspaceStore(
    (state) => state.selectProjectContext,
  );
  const parentProjectId = useTerminalWorkspaceStore(
    (state) => state.activeParentProjectId,
  );
  const activeSessionId = useTerminalWorkspaceStore(
    (state) => state.activeSessionId,
  );
  const [snapshot, setSnapshot] = useState<DevResourcesSnapshot | null>(null);
  const [filter, setFilter] = useState<ResourceFilter>("all");
  const [expanded, setExpanded] = useState(new Set<string>());
  const [target, setTarget] = useState<DevResource | null>(null);
  const [loading, setLoading] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(
    null,
  );
  const mounted = useRef(false);
  const reading = useRef<AbortController | null>(null);
  const submitting = useRef(false);
  const back = useMemoizedFn(() =>
    navigate(
      activeSessionId
        ? `/terminal/${encodeURIComponent(activeSessionId)}`
        : "/terminal",
    ),
  );
  const selectContext = useMemoizedFn((projectId: string) => {
    selectTerminalProjectContext({
      activeParentProjectId: parentProjectId,
      projectId,
      sessions,
      scope,
      selectProjectContext,
    });
    const selected = useTerminalWorkspaceStore.getState().activeSessionId;
    navigate(
      selected ? `/terminal/${encodeURIComponent(selected)}` : "/terminal",
    );
  });
  const refresh = useMemoizedFn(async () => {
    if (reading.current || !mounted.current) return;
    const controller = new AbortController();
    reading.current = controller;
    setLoading(true);
    try {
      const value = await getDevResources(apiBase, token, controller.signal);
      if (!controller.signal.aborted && mounted.current) {
        setSnapshot(value);
        setError(null);
      }
    } catch (failure) {
      if (!controller.signal.aborted && mounted.current) {
        setSnapshot(null);
        setError(
          failure instanceof Error ? failure.message : "无法获取当前资源状态",
        );
        if (failure instanceof HttpError && failure.status === 401)
          onAuthExpired();
      }
    } finally {
      if (reading.current === controller) reading.current = null;
      if (mounted.current) setLoading(false);
    }
  });
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    // The microtask avoids duplicate entry reads from StrictMode's setup/cleanup rehearsal.
    void Promise.resolve().then(() => {
      if (!cancelled) void refresh();
    });
    return () => {
      cancelled = true;
      mounted.current = false;
      reading.current?.abort();
      reading.current = null;
    };
  }, [refresh]);
  const confirm = useMemoizedFn(async () => {
    if (
      !target?.release.action ||
      !target.ownershipVersion ||
      submitting.current
    )
      return;
    submitting.current = true;
    setReleasing(true);
    setNotice(null);
    try {
      const result = await releaseDevResource(apiBase, token, target.id, {
        action: target.release.action,
        expectedOwnershipVersion: target.ownershipVersion,
        idempotencyKey: crypto.randomUUID(),
      });
      if (mounted.current)
        setNotice({
          error: result.state !== "released",
          text:
            result.state === "running"
              ? "释放仍在进行，请稍后手动刷新查看结果"
              : result.message,
        });
    } catch (failure) {
      if (mounted.current) {
        setNotice({
          error: true,
          text:
            failure instanceof HttpError
              ? failure.message
              : "释放结果尚未确认，请手动刷新核查",
        });
        if (failure instanceof HttpError && failure.status === 401)
          onAuthExpired();
      }
    } finally {
      if (mounted.current) {
        setTarget(null);
        await refresh();
        setReleasing(false);
      }
      submitting.current = false;
    }
  });
  const toggle = useMemoizedFn((id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    }),
  );
  const pending = snapshot
    ? (snapshot.desktop.counts.blocked ?? 0) +
      (snapshot.desktop.counts.unknown ?? 0) +
      (snapshot.simulators.counts.blocked ?? 0) +
      (snapshot.simulators.counts.unknown ?? 0) +
      snapshot.desktop.sessions.filter(
        (item) => item.state === "blocked" || item.state === "unknown",
      ).length
    : null;
  return (
    <main className="flex h-dvh flex-col overflow-hidden bg-slate-950 text-slate-200">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-slate-800 px-4">
        <Activity className="h-4 w-4 text-sky-300" />
        <span className="text-sm font-semibold">Runweave</span>
        <span className="ml-auto text-xs text-slate-400">
          {connectionName ?? "当前连接"} ·{" "}
          {snapshot?.hostName ?? "资源状态读取中"}
        </span>
      </header>
      <div className="flex min-h-0 flex-1">
        <TerminalWorktreeRail
          parentProjectId={parentProjectId}
          onSelectContext={selectContext}
          resourcesActive
        />
        <div className="min-w-0 flex-1 overflow-y-auto p-5 md:p-9">
          <div className="mx-auto max-w-[1280px] space-y-6">
            <header className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-xs text-slate-500">当前连接电脑</p>
                <h1 className="mt-2 text-2xl font-semibold">开发资源</h1>
                <p className="mt-2 text-sm text-slate-400">
                  {snapshot?.hostName ?? connectionName ?? "当前连接"} /
                  测试环境
                </p>
              </div>
              <div className="flex items-center gap-3">
                <Button variant="ghost" size="sm" onClick={back}>
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  返回终端
                </Button>
                <span
                  className="text-xs text-slate-500"
                  data-testid="dev-resources-updated-at"
                >
                  {loading
                    ? "正在更新…"
                    : snapshot
                      ? `更新于 ${timeLabel(snapshot.observedAt)}`
                      : "未取得当前状态"}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={loading || releasing}
                  onClick={() => {
                    setNotice(null);
                    void refresh();
                  }}
                >
                  <RefreshCw
                    className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`}
                  />
                  刷新
                </Button>
              </div>
            </header>
            <div className="grid gap-4 lg:grid-cols-3">
              <Overview title="桌面测试" group={snapshot?.desktop} />
              <Overview
                title="模拟器测试"
                group={snapshot?.simulators}
                simulator
              />
              <section
                aria-label="待检查总览"
                className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-5"
              >
                <p className="flex items-center gap-2 text-sm text-amber-300">
                  <AlertTriangle className="h-4 w-4" />
                  待检查
                </p>
                <p className="my-4 text-3xl font-semibold">
                  {snapshot &&
                  snapshot.desktop.sourceState !== "unavailable" &&
                  snapshot.simulators.sourceState !== "unavailable"
                    ? pending
                    : "—"}
                </p>
                <button
                  className="text-xs text-amber-300 hover:underline"
                  onClick={() => setFilter("attention")}
                >
                  查看待检查资源
                </button>
              </section>
            </div>
            {notice && (
              <p
                role={notice.error ? "alert" : "status"}
                className={`rounded-lg border p-3 text-sm ${notice.error ? "border-amber-500/30 text-amber-300" : "border-emerald-500/30 text-emerald-300"}`}
              >
                {notice.text}
              </p>
            )}
            {error && (
              <p
                role="alert"
                className="rounded border border-amber-500/25 p-4 text-sm text-amber-300"
              >
                无法获取当前资源状态：{error}。请手动刷新重试。
              </p>
            )}
            {snapshot && (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm text-slate-400">资源列表</p>
                  <div
                    className="flex flex-wrap gap-1 rounded border border-slate-800 p-1"
                    aria-label="资源状态筛选"
                  >
                    {(
                      ["all", "busy", "free", "blocked", "unknown"] as const
                    ).map((value) => (
                      <button
                        key={value}
                        className={`rounded px-3 py-1.5 text-xs ${filter === value ? "bg-slate-800 text-slate-100" : "text-slate-400"}`}
                        aria-pressed={filter === value}
                        onClick={() => setFilter(value)}
                      >
                        {value === "all" ? "全部状态" : stateLabels[value]}
                      </button>
                    ))}
                  </div>
                </div>
                <ResourceList
                  title="桌面测试"
                  group={snapshot.desktop}
                  sessions={snapshot.desktop.sessions}
                  observedAt={snapshot.observedAt}
                  filter={filter}
                  expanded={expanded}
                  onToggle={toggle}
                  onRelease={setTarget}
                  pending={loading || releasing}
                />
                <ResourceList
                  title="模拟器测试"
                  group={snapshot.simulators}
                  observedAt={snapshot.observedAt}
                  filter={filter}
                  expanded={expanded}
                  onToggle={toggle}
                  onRelease={setTarget}
                  pending={loading || releasing}
                />
              </>
            )}
            {!snapshot && !error && (
              <p
                role="status"
                className="p-8 text-center text-sm text-slate-500"
              >
                正在读取当前资源…
              </p>
            )}
            <p className="text-xs text-slate-500">当前快照</p>
          </div>
        </div>
      </div>
      <AlertDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open && !releasing) setTarget(null);
        }}
      >
        <AlertDialogContent
          onEscapeKeyDown={(event) => {
            if (releasing) event.preventDefault();
          }}
          className="rounded-lg"
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {target?.release.action === "stop-and-release"
                ? "停止并释放资源？"
                : "释放资源占用？"}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-4 text-sm text-slate-400">
                <p>
                  {target?.release.action === "stop-and-release"
                    ? "当前测试正在使用这个资源。继续操作会中断该测试。"
                    : "将重新核对占用归属并清理残留。"}
                </p>
                <dl className="space-y-2 rounded border border-slate-800 p-3">
                  {[
                    ["资源", target?.label],
                    ["占用任务", target?.owner?.task ?? target?.owner?.id],
                    ["工作树", target?.owner?.worktree],
                  ].map(([name, value]) => (
                    <div key={name} className="grid grid-cols-[80px_1fr] gap-3">
                      <dt>{name}</dt>
                      <dd className="break-all text-slate-200">
                        {value ?? "—"}
                      </dd>
                    </div>
                  ))}
                </dl>
                <p>
                  {target?.kind === "simulator"
                    ? "将停止该任务的 Runner、关闭模拟器并释放占用。"
                    : "将清理该测试环境自有的服务和占用，保留共享服务。"}
                  归属核对或清理未完成时，资源仍保持占用。
                </p>
                {releasing && <p role="status">正在核对占用并释放资源…</p>}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={releasing}>取消</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={releasing}
              onClick={() => void confirm()}
            >
              {releasing
                ? "释放中…"
                : target?.release.action === "stop-and-release"
                  ? "确认停止并释放"
                  : "确认释放占用"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}

export function DevResourcesPage(props: Props) {
  return (
    <TerminalRuntimeProvider
      apiBase={props.apiBase}
      token={props.token}
      activeConnectionId={props.activeConnectionId}
      connectionGeneration={props.connectionGeneration}
      onAuthExpired={props.onAuthExpired}
    >
      <PageContent
        key={`${props.activeConnectionId}:${props.apiBase}:${props.connectionGeneration}:${props.token}`}
        {...props}
      />
    </TerminalRuntimeProvider>
  );
}
