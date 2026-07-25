import type {
  CandidateAsset,
  EvolutionProviderAvailability,
  EvolutionRun,
  EvolutionSchedule,
  Insight,
} from "@runweave/shared/evolution";
import {
  CalendarClock,
  History,
  Home,
  Lightbulb,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Button } from "../../components/ui/button";

export type EvolutionView =
  | "overview"
  | "runs"
  | "insights"
  | "candidates"
  | "schedules";

export interface EvolutionScopeOption {
  id: string;
  kind: "global" | "project";
  label: string;
  description: string;
}

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const VIEW_ITEMS: Array<{
  id: EvolutionView;
  label: string;
  icon: typeof Sparkles;
}> = [
  { id: "overview", label: "概览", icon: Sparkles },
  { id: "runs", label: "运行记录", icon: History },
  { id: "insights", label: "洞察", icon: Lightbulb },
  { id: "candidates", label: "资产候选", icon: ShieldCheck },
  { id: "schedules", label: "运行计划", icon: CalendarClock },
];

export const EVOLUTION_STAGE_LABELS: Record<EvolutionRun["stage"], string> = {
  queued: "排队中",
  snapshotting: "冻结证据",
  segmenting: "构建片段",
  independent_analysis: "独立分析",
  cross_questioning: "交叉质疑",
  adjudicating: "裁决",
  novelty_check: "新颖性检查",
  validating: "验证",
  completed: "已完成",
  no_material_novelty: "无实质新知识",
  partial: "部分完成",
  failed: "失败",
  cancelled: "已取消",
  blocked: "已阻塞",
};

export const TERMINAL_STAGES = new Set<EvolutionRun["stage"]>([
  "completed",
  "no_material_novelty",
  "partial",
  "failed",
  "cancelled",
  "blocked",
]);

export function formatEvolutionDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : DATE_TIME_FORMATTER.format(date);
}

function statusClass(
  status:
    | EvolutionRun["stage"]
    | CandidateAsset["lifecycle"]
    | "available"
    | "unavailable",
): string {
  if (
    status === "completed" ||
    status === "promoted" ||
    status === "available"
  ) {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300";
  }
  if (
    status === "failed" ||
    status === "blocked" ||
    status === "rejected" ||
    status === "unavailable"
  ) {
    return "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-300";
  }
  if (
    status === "partial" ||
    status === "no_material_novelty" ||
    status === "canary" ||
    status === "needs_revalidation"
  ) {
    return "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300";
  }
  return "border-border bg-muted/60 text-muted-foreground";
}

export function EvolutionStatusPill({
  status,
  label,
}: {
  status: Parameters<typeof statusClass>[0];
  label: string;
}) {
  return (
    <span
      className={`inline-flex rounded-full border px-2.5 py-1 text-[0.68rem] font-medium ${statusClass(status)}`}
    >
      {label}
    </span>
  );
}

export function EvolutionPanel({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-border/70 bg-card/80 shadow-[0_20px_80px_-64px_rgba(17,24,39,0.8)] ${className}`}
    >
      {children}
    </section>
  );
}

export function EvolutionSidebar({
  view,
  scopes,
  selectedScopeId,
  counts,
  providers,
  onSelectView,
  onSelectScope,
  onNavigateHome,
}: {
  view: EvolutionView;
  scopes: EvolutionScopeOption[];
  selectedScopeId: string;
  counts: Partial<Record<EvolutionView, number>>;
  providers: EvolutionProviderAvailability[];
  onSelectView: (view: EvolutionView) => void;
  onSelectScope: (scopeId: string) => void;
  onNavigateHome: () => void;
}) {
  const selectedScope = scopes.find((scope) => scope.id === selectedScopeId);
  const globalScope = scopes.find((scope) => scope.kind === "global");
  const projectScopes = scopes.filter((scope) => scope.kind === "project");

  return (
    <aside className="flex min-h-0 flex-col border-r border-border/70 bg-card/55 p-3 max-md:border-b max-md:border-r-0">
      <div className="flex items-center justify-between gap-3 px-2 py-3">
        <div>
          <p className="text-[0.68rem] font-semibold uppercase tracking-[0.3em] text-foreground">
            Runweave
          </p>
          <p className="mt-1 text-xs text-muted-foreground">Evolution</p>
        </div>
        <Button variant="ghost" size="icon" onClick={onNavigateHome}>
          <Home className="h-4 w-4" />
          <span className="sr-only">返回首页</span>
        </Button>
      </div>

      <div className="mt-2 rounded-lg border border-border/70 bg-background/55 p-3">
        <p className="text-[0.65rem] font-medium uppercase tracking-[0.2em] text-muted-foreground">
          复盘范围
        </p>
        {scopes.length > 0 ? (
          <select
            aria-label="复盘范围"
            className="mt-2 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={selectedScopeId}
            onChange={(event) => onSelectScope(event.target.value)}
          >
            {globalScope ? (
              <option value={globalScope.id}>{globalScope.label}</option>
            ) : null}
            {projectScopes.length > 0 ? (
              <optgroup label="按项目">
                {projectScopes.map((scope) => (
                  <option key={scope.id} value={scope.id}>
                    {scope.label}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">正在读取可用范围</p>
        )}
        {selectedScope ? (
          <div className="mt-2 min-w-0 space-y-1">
            <p className="truncate text-xs font-medium text-foreground">
              {selectedScope.label}
            </p>
            <p
              className="text-[0.68rem] leading-5 text-muted-foreground"
              title={selectedScope.description}
            >
              {selectedScope.description}
            </p>
          </div>
        ) : null}
      </div>

      <nav
        className="mt-4 grid gap-1 max-md:grid-cols-5 max-sm:grid-cols-2"
        aria-label="Evolution 导航"
      >
        {VIEW_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors ${
                view === item.id
                  ? "bg-primary/12 font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
              }`}
              onClick={() => onSelectView(item.id)}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {counts[item.id] !== undefined ? (
                <span className="rounded-full bg-muted px-2 py-0.5 text-[0.65rem] tabular-nums">
                  {counts[item.id]}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      <div className="mt-auto space-y-2 px-2 pt-5 text-xs text-muted-foreground max-md:hidden">
        {providers.map((provider) => (
          <div key={provider.provider} className="flex items-center gap-2">
            <span
              className={`h-2 w-2 rounded-full ${
                provider.available ? "bg-emerald-500" : "bg-amber-500"
              }`}
            />
            <span className="capitalize">{provider.provider}</span>
            <span>{provider.available ? "可用" : "未接入"}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}

export function EvolutionHeader({
  view,
  scopeLabel,
  reflectionPending,
  onStartReflection,
  onOpenSchedule,
}: {
  view: EvolutionView;
  scopeLabel: string;
  reflectionPending: boolean;
  onStartReflection: () => void;
  onOpenSchedule: () => void;
}) {
  const copy: Record<EvolutionView, [string, string]> = {
    overview: ["进化概览", "运行、候选资产与激活状态"],
    runs: ["运行记录", "查看真实队列、阶段、预算与 RuntimeTrace"],
    insights: ["洞察", "分析链路产出的长期结论与 revision"],
    candidates: ["资产候选", "查看候选生命周期与真实注入策略"],
    schedules: ["运行计划", "管理持久化的 cron、时区和数据窗口"],
  };
  return (
    <header className="flex items-center justify-between gap-4 border-b border-border/70 px-6 py-4 max-sm:items-start max-sm:px-4">
      <div>
        <h1 className="text-lg font-semibold">{copy[view][0]}</h1>
        <p className="mt-1 text-xs text-muted-foreground">{copy[view][1]}</p>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button variant="secondary" size="sm" onClick={onOpenSchedule}>
          <CalendarClock className="h-4 w-4" />
          <span className="max-sm:hidden">运行计划</span>
        </Button>
        <Button
          size="sm"
          disabled={reflectionPending}
          onClick={onStartReflection}
        >
          <Sparkles className="h-4 w-4" />
          <span className="max-sm:hidden">
            {reflectionPending ? "正在发起…" : `复盘 ${scopeLabel}`}
          </span>
          <span className="sm:hidden">
            {reflectionPending ? "发起中…" : "开始复盘"}
          </span>
        </Button>
      </div>
    </header>
  );
}

export function EvolutionErrorNotice({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-200"
    >
      <span>{message}</span>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RefreshCw className="h-4 w-4" />
        重试
      </Button>
    </div>
  );
}

export function EvolutionOverview({
  runs,
  insights,
  candidates,
  schedules,
  providers,
  runtimeAvailable,
  scopeLabel,
  onSelectRun,
  onSelectView,
}: {
  runs: EvolutionRun[];
  insights: Insight[];
  candidates: CandidateAsset[];
  schedules: EvolutionSchedule[];
  providers: EvolutionProviderAvailability[];
  runtimeAvailable: boolean;
  scopeLabel: string;
  onSelectRun: (runId: string) => void;
  onSelectView: (view: EvolutionView) => void;
}) {
  const activeRuns = runs.filter((run) => !TERMINAL_STAGES.has(run.stage));
  const latestRun = runs[0];
  const unavailableProviders = providers.filter(
    (provider) => !provider.available,
  );

  return (
    <div className="space-y-4">
      {!runtimeAvailable || unavailableProviders.length > 0 ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
          {!runtimeAvailable
            ? "Evolution runtime 当前不可用；页面保持只读并展示后端返回的降级状态。"
            : `${unavailableProviders
                .map(
                  (item) =>
                    `${item.provider}${item.reason ? ` (${item.reason})` : ""}`,
                )
                .join(
                  "、",
                )} Provider 尚不可用；不会将单 Provider 结果标记为交叉验证。`}
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["运行总数", runs.length, "真实持久化 Run"],
          ["进行中", activeRuns.length, "queued 或执行阶段"],
          ["长期洞察", insights.length, `${candidates.length} 条候选资产`],
          [
            "运行计划",
            schedules.filter((schedule) => schedule.enabled).length,
            `${schedules.length} 条已配置`,
          ],
        ].map(([label, value, detail]) => (
          <EvolutionPanel key={label as string} className="p-4">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-3 text-3xl font-semibold tabular-nums">{value}</p>
            <p className="mt-2 text-xs text-muted-foreground">{detail}</p>
          </EvolutionPanel>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(280px,0.7fr)]">
        <EvolutionPanel>
          <div className="flex items-center justify-between border-b border-border/70 px-5 py-4">
            <div>
              <h2 className="font-semibold">最近一次反思</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                当前 Backend 返回的真实 Run 状态
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onSelectView("runs")}
            >
              全部运行
            </Button>
          </div>
          {latestRun ? (
            <button
              type="button"
              className="w-full p-5 text-left hover:bg-muted/30"
              onClick={() => onSelectRun(latestRun.runId)}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-medium">{scopeLabel}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {latestRun.profile} · {latestRun.providerPolicy} · attempt{" "}
                    {latestRun.attempt}
                  </p>
                </div>
                <EvolutionStatusPill
                  status={latestRun.stage}
                  label={EVOLUTION_STAGE_LABELS[latestRun.stage]}
                />
              </div>
              <div className="mt-5 grid gap-3 sm:grid-cols-3">
                <div className="rounded-lg bg-muted/45 p-3">
                  <p className="text-xs text-muted-foreground">创建时间</p>
                  <p className="mt-1 text-sm">
                    {formatEvolutionDate(latestRun.createdAt)}
                  </p>
                </div>
                <div className="rounded-lg bg-muted/45 p-3">
                  <p className="text-xs text-muted-foreground">模型轮次预算</p>
                  <p className="mt-1 text-sm">
                    {latestRun.budget.maxModelTurns}
                  </p>
                </div>
                <div className="rounded-lg bg-muted/45 p-3">
                  <p className="text-xs text-muted-foreground">工具调用预算</p>
                  <p className="mt-1 text-sm">
                    {latestRun.budget.maxToolCalls}
                  </p>
                </div>
              </div>
            </button>
          ) : (
            <div className="p-8 text-center text-sm text-muted-foreground">
              尚无运行。发起第一次反思后，真实状态会显示在这里。
            </div>
          )}
        </EvolutionPanel>

        <EvolutionPanel className="p-5">
          <div className="flex items-center gap-2">
            <Lightbulb className="h-4 w-4 text-amber-500" />
            <h2 className="font-semibold">洞察链路</h2>
          </div>
          {insights[0] ? (
            <>
              <p className="mt-4 text-sm font-medium leading-6">
                {currentInsightRevision(insights[0])?.statement}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                {insights[0].topicKey} · {insights[0].revisions.length} 个
                revision
              </p>
            </>
          ) : (
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              尚无真实 Insight。没有实质新知识时，Run 会合法零产出。
            </p>
          )}
          <Button
            className="mt-5"
            variant="outline"
            size="sm"
            onClick={() => onSelectView("insights")}
          >
            查看接入状态
          </Button>
        </EvolutionPanel>
      </div>
    </div>
  );
}

export function EvolutionLoadingPanel() {
  return (
    <div className="flex min-h-[420px] items-center justify-center text-sm text-muted-foreground">
      <Play className="mr-2 h-4 w-4 animate-pulse" />
      正在读取 Evolution 控制面…
    </div>
  );
}

function currentInsightRevision(insight: Insight) {
  return insight.revisions.find(
    (revision) => revision.revisionId === insight.currentRevisionId,
  );
}
