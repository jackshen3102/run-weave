import { useState } from "react";
import { useDebounce, useMemoizedFn } from "ahooks";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { ArrowLeft, Gauge, ListFilter } from "lucide-react";
import type {
  EfficiencyDimension,
  EfficiencyFindingStatus,
} from "@runweave/shared/execution-efficiency";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { ConnectionSwitcher } from "../components/connection-switcher";
import type { ConnectionConfig } from "../features/connection/types";
import { buildConnectionQueryScope } from "../features/query/connection-query-provider";
import { EfficiencyFindingDetailView } from "../features/execution-efficiency/detail";
import { EfficiencyFindingList } from "../features/execution-efficiency/list";
import { useEfficiencyNavigation } from "../features/execution-efficiency/navigation";
import {
  efficiencyKeys,
  useEfficiencyApi,
  useEfficiencyFindings,
  useEfficiencyStatus,
} from "../features/execution-efficiency/queries";
import { useCapabilities, useTasks } from "../features/scheduled-tasks/queries";
import { TerminalRuntimeProvider } from "../features/terminal/queries/provider";
import { useTerminalProjectsQuery } from "../features/terminal/queries/workspace";

interface Props {
  apiBase: string;
  token: string;
  activeConnectionId: string | null;
  activeConnectionGeneration?: number;
  connectionName?: string;
  connections: ConnectionConfig[];
  onSelectConnection?: (id: string) => void;
  onOpenConnectionManager?: () => void;
}

export function ExecutionEfficiencyPage(props: Props) {
  const scope = buildConnectionQueryScope({
    apiBase: props.apiBase,
    connectionId: props.activeConnectionId,
    generation: props.activeConnectionGeneration,
  });
  return (
    <TerminalRuntimeProvider
      apiBase={props.apiBase}
      token={props.token}
      activeConnectionId={props.activeConnectionId}
      connectionGeneration={props.activeConnectionGeneration}
    >
      <ExecutionEfficiencyContent key={scope} {...props} />
    </TerminalRuntimeProvider>
  );
}

function ExecutionEfficiencyContent(props: Props) {
  const { findingId } = useParams<{ findingId: string }>();
  const { workspace, go, back } = useEfficiencyNavigation();
  const projects = useTerminalProjectsQuery();
  const [selectedProject, setSelectedProject] = useState(
    workspace.projectId ?? workspace.parentProjectId ?? "",
  );
  const projectId = selectedProject || projects.data?.[0]?.projectId || "";
  const [dimension, setDimension] = useState<EfficiencyDimension>("duration");
  const [status, setStatus] = useState<EfficiencyFindingStatus | "">("");
  const [search, setSearch] = useState("");
  const query = useDebounce(search, { wait: 250 });
  const statusQuery = useEfficiencyStatus(projectId);
  const findings = useEfficiencyFindings({
    projectId,
    dimension,
    status: status || undefined,
    q: query || undefined,
    limit: 100,
  });
  const capabilities = useCapabilities();
  const tasks = useTasks(
    { projectId, archived: false, limit: 100 },
    Boolean(projectId) && capabilities.data?.enabled === true,
  );
  const records = tasks.data?.pages.flatMap((page) => page.items) ?? [];
  const [bindingTaskId, setBindingTaskId] = useState("");
  const bindingValue = bindingTaskId || statusQuery.data?.binding?.taskId || "";
  const { api, scope } = useEfficiencyApi();
  const queryClient = useQueryClient();
  const bind = useMutation({
    mutationFn: () =>
      api.bind({
        projectId,
        taskId: bindingValue,
        expectedRevision: statusQuery.data?.binding?.revision ?? 0,
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: efficiencyKeys.all(scope) }),
  });
  const saveBinding = useMemoizedFn(() => {
    if (projectId && bindingValue) bind.mutate();
  });
  return (
    <main className="min-h-dvh bg-background text-foreground">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b bg-background/95 px-4 py-3 backdrop-blur">
        <Button variant="ghost" size="sm" onClick={back}>
          <ArrowLeft className="h-4 w-4" />
          返回工作区
        </Button>
        <Gauge className="h-4 w-4" />
        <span className="font-semibold">执行效率</span>
        <div className="ml-auto">
          {props.activeConnectionId &&
          props.onSelectConnection &&
          props.onOpenConnectionManager ? (
            <ConnectionSwitcher
              connections={props.connections}
              activeConnectionId={props.activeConnectionId}
              activeConnectionName={props.connectionName}
              onSelectConnection={(id) => {
                go("/execution-efficiency");
                props.onSelectConnection?.(id);
              }}
              onOpenConnectionManager={props.onOpenConnectionManager}
            />
          ) : (
            <span className="text-xs text-muted-foreground">
              {props.connectionName ?? "当前 Backend"}
            </span>
          )}
        </div>
      </header>
      <div className="mx-auto max-w-6xl space-y-5 px-4 py-6">
        {findingId ? (
          <EfficiencyFindingDetailView
            findingId={findingId}
            onBack={() => go("/execution-efficiency")}
            onOpenTask={(taskId) =>
              go(`/scheduled-tasks/${encodeURIComponent(taskId)}`)
            }
          />
        ) : (
          <>
            <section className="grid gap-3 rounded-xl border p-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,1fr)]">
              <div>
                <h1 className="text-xl font-semibold">执行效率候选</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  耗时与 Token 分开记录；观测开销不是可直接节省的数值。
                </p>
                <label className="mt-4 grid gap-1 text-sm">
                  项目
                  <select
                    className="h-10 rounded-md border bg-background px-3"
                    value={projectId}
                    onChange={(event) => setSelectedProject(event.target.value)}
                  >
                    {projects.data?.map((project) => (
                      <option key={project.projectId} value={project.projectId}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <BindingPanel
                available={statusQuery.data?.available !== false}
                unavailableReason={statusQuery.data?.reason}
                tasks={records.map((task) => ({
                  id: task.id,
                  name: task.name,
                }))}
                value={bindingValue}
                revision={statusQuery.data?.binding?.revision ?? 0}
                pending={bind.isPending}
                error={bind.error ?? statusQuery.error}
                onChange={setBindingTaskId}
                onSave={saveBinding}
                onOpen={() =>
                  bindingValue
                    ? go(`/scheduled-tasks/${encodeURIComponent(bindingValue)}`)
                    : go("/scheduled-tasks")
                }
              />
            </section>
            <AnalysisSummary status={statusQuery.data} />
            <section className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex rounded-lg border p-1">
                  <Button
                    size="sm"
                    variant={dimension === "duration" ? "secondary" : "ghost"}
                    onClick={() => setDimension("duration")}
                  >
                    执行耗时
                  </Button>
                  <Button
                    size="sm"
                    variant={dimension === "tokens" ? "secondary" : "ghost"}
                    onClick={() => setDimension("tokens")}
                  >
                    Token 用量
                  </Button>
                </div>
                <ListFilter className="ml-auto h-4 w-4 text-muted-foreground" />
                <select
                  aria-label="状态筛选"
                  className="h-9 rounded-md border bg-background px-3 text-sm"
                  value={status}
                  onChange={(event) =>
                    setStatus(
                      event.target.value as EfficiencyFindingStatus | "",
                    )
                  }
                >
                  <option value="">全部状态</option>
                  <option value="pending">待处理</option>
                  <option value="processing">处理中</option>
                  <option value="resolved">已处理</option>
                  <option value="deferred">暂不处理</option>
                  <option value="dismissed">已排除</option>
                </select>
                <Input
                  className="w-full sm:w-64"
                  aria-label="搜索效率候选"
                  placeholder="搜索标题或说明"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
              {findings.isPending ? (
                <p>正在加载候选…</p>
              ) : findings.error ? (
                <p role="alert" className="text-sm text-destructive">
                  {String(findings.error)}
                </p>
              ) : (
                <EfficiencyFindingList
                  items={findings.data?.items ?? []}
                  onOpen={(id) =>
                    go(`/execution-efficiency/${encodeURIComponent(id)}`)
                  }
                />
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}

function BindingPanel({
  available,
  unavailableReason,
  tasks,
  value,
  revision,
  pending,
  error,
  onChange,
  onSave,
  onOpen,
}: {
  available: boolean;
  unavailableReason?: string;
  tasks: Array<{ id: string; name: string }>;
  value: string;
  revision: number;
  pending: boolean;
  error: unknown;
  onChange: (value: string) => void;
  onSave: () => void;
  onOpen: () => void;
}) {
  if (!available) {
    return (
      <div className="rounded-lg bg-destructive/10 p-4 text-sm text-destructive">
        {unavailableReason ?? "当前 Backend 不支持执行效率记录"}
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-lg bg-muted/40 p-4">
      <p className="text-sm font-medium">关联现有 Codex 定时任务</p>
      <select
        className="h-10 w-full rounded-md border bg-background px-3 text-sm"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">尚未关联</option>
        {tasks.map((task) => (
          <option key={task.id} value={task.id}>
            {task.name}
          </option>
        ))}
      </select>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!value || pending} onClick={onSave}>
          {pending ? "保存中…" : revision ? "更新关联" : "保存关联"}
        </Button>
        <Button size="sm" variant="outline" onClick={onOpen}>
          {value ? "查看并立即运行" : "前往任务页"}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {String(error)}
        </p>
      ) : null}
    </div>
  );
}

function AnalysisSummary({
  status,
}: {
  status: ReturnType<typeof useEfficiencyStatus>["data"];
}) {
  const run = status?.latestAnalysis;
  if (!run) {
    return (
      <section className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
        {status?.binding
          ? "尚无真实分析运行。请到关联任务页面手动运行。"
          : "尚未关联分析任务；补充问题会保留，但不会自动执行。"}
      </section>
    );
  }
  const usage = run.analysisUsage;
  return (
    <section className="grid gap-3 rounded-xl border p-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
      <Summary
        label="扫描"
        value={`${run.coverage.sessionsAccepted} 个会话 · ${run.coverage.bytesRead.toLocaleString()} 字节`}
      />
      <Summary
        label="初筛观测"
        value={String(run.coverage.observationsCreated)}
      />
      <Summary label="正式结果" value={String(run.resultCount)} />
      <Summary
        label="分析用量"
        value={
          usage
            ? `输入 ${value(usage.input)} · 缓存 ${value(usage.cachedInput)} · 输出 ${value(usage.output)}`
            : run.analysisUsageCompleteness === "pending"
              ? "计量中"
              : "未记录"
        }
      />
    </section>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1">{value}</p>
    </div>
  );
}

function value(input: number | null): string {
  return input === null ? "未记录" : input.toLocaleString("en-US");
}
