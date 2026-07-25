import type {
  EvolutionRun,
  EvolutionRunArtifacts,
  RuntimeTraceSummary,
} from "@runweave/shared/evolution";
import { Activity, Lightbulb, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "../../components/ui/button";
import {
  formatEvolutionDate,
  EvolutionPanel,
  EvolutionStatusPill,
  EVOLUTION_STAGE_LABELS,
  TERMINAL_STAGES,
} from "./evolution-page-panels";

export function EvolutionRunsPanel({
  runs,
  scopeLabel,
  selectedRunId,
  traces,
  artifacts,
  actionPending,
  onSelectRun,
  onCancelRun,
  onRetryRun,
}: {
  runs: EvolutionRun[];
  scopeLabel: string;
  selectedRunId: string | null;
  traces: RuntimeTraceSummary[];
  artifacts: EvolutionRunArtifacts | undefined;
  actionPending: boolean;
  onSelectRun: (runId: string) => void;
  onCancelRun: (runId: string) => void;
  onRetryRun: (runId: string) => void;
}) {
  const selectedRun =
    runs.find((run) => run.runId === selectedRunId) ?? runs[0] ?? null;
  return (
    <div className="grid min-h-full gap-4 xl:grid-cols-[minmax(280px,0.7fr)_minmax(0,1.3fr)]">
      <EvolutionPanel className="min-h-0 overflow-hidden">
        <div className="border-b border-border/70 px-4 py-3">
          <h2 className="font-semibold">运行队列</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {runs.length} 条真实记录
          </p>
        </div>
        <div className="max-h-[calc(100dvh-190px)] overflow-auto">
          {runs.length > 0 ? (
            runs.map((run) => (
              <button
                key={run.runId}
                type="button"
                className={`block w-full border-b border-border/60 p-4 text-left last:border-b-0 ${
                  selectedRun?.runId === run.runId
                    ? "bg-primary/8"
                    : "hover:bg-muted/35"
                }`}
                onClick={() => onSelectRun(run.runId)}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 truncate text-sm font-medium">
                    {scopeLabel}
                  </p>
                  <EvolutionStatusPill
                    status={run.stage}
                    label={EVOLUTION_STAGE_LABELS[run.stage]}
                  />
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {formatEvolutionDate(run.createdAt)} · {run.profile} ·{" "}
                  {run.providerPolicy}
                </p>
              </button>
            ))
          ) : (
            <p className="p-6 text-sm text-muted-foreground">
              暂无 Evolution Run。
            </p>
          )}
        </div>
      </EvolutionPanel>

      <EvolutionPanel className="min-w-0 p-5">
        {selectedRun ? (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                  Run detail
                </p>
                <h2 className="mt-2 truncate text-xl font-semibold">
                  {selectedRun.runId}
                </h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  {scopeLabel} · {selectedRun.trigger.type}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <EvolutionStatusPill
                  status={selectedRun.stage}
                  label={EVOLUTION_STAGE_LABELS[selectedRun.stage]}
                />
                {!TERMINAL_STAGES.has(selectedRun.stage) ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={actionPending}
                    onClick={() => onCancelRun(selectedRun.runId)}
                  >
                    取消
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={actionPending}
                    onClick={() => onRetryRun(selectedRun.runId)}
                  >
                    <RefreshCw className="h-4 w-4" />
                    重试
                  </Button>
                )}
              </div>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg bg-muted/45 p-3">
                <p className="text-xs text-muted-foreground">Profile</p>
                <p className="mt-1 text-sm capitalize">{selectedRun.profile}</p>
              </div>
              <div className="rounded-lg bg-muted/45 p-3">
                <p className="text-xs text-muted-foreground">Provider policy</p>
                <p className="mt-1 text-sm capitalize">
                  {selectedRun.providerPolicy}
                </p>
              </div>
              <div className="rounded-lg bg-muted/45 p-3">
                <p className="text-xs text-muted-foreground">数据上界</p>
                <p className="mt-1 truncate text-sm">
                  {formatEvolutionDate(selectedRun.dataRange.atOrBefore)}
                </p>
              </div>
              <div className="rounded-lg bg-muted/45 p-3">
                <p className="text-xs text-muted-foreground">最长时间</p>
                <p className="mt-1 text-sm">
                  {Math.round(selectedRun.budget.maxWallTimeMs / 60_000)} 分钟
                </p>
              </div>
            </div>

            {artifacts?.contextPack ? (
              <ReflectionResult artifacts={artifacts} />
            ) : null}

            <div className="mt-6 border-t border-border/70 pt-6">
              <h3 className="font-semibold">审计详情</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                冻结证据、独立报告、Claim 与 Novelty 的真实持久化结果
              </p>
            </div>
            {artifacts ? (
              <div className="mt-3 space-y-3">
                {artifacts.contextPack?.dataQualityIssues.length ? (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
                    <p className="text-xs font-medium text-amber-700 dark:text-amber-200">
                      DataQuality ·{" "}
                      {artifacts.contextPack.dataQualityIssues.length} 项
                    </p>
                    {summarizeDataQuality(
                      artifacts.contextPack.dataQualityIssues,
                    ).map((issue) => (
                      <p
                        key={issue.code}
                        className="mt-1 text-xs text-muted-foreground"
                      >
                        {issue.code} · {issue.count} 项：{issue.detail}
                      </p>
                    ))}
                  </div>
                ) : null}
                <div className="grid gap-3 lg:grid-cols-3">
                  <div className="rounded-lg border border-border/70 p-3">
                    <p className="text-xs font-medium">
                      Attempts · {artifacts.attempts.length}
                    </p>
                    <div className="mt-2 space-y-2">
                      {artifacts.attempts.map((attempt) => (
                        <div
                          key={attempt.attemptId}
                          className="rounded-md bg-muted/45 p-2"
                        >
                          <div className="flex flex-wrap items-center gap-2 text-xs">
                            <span className="font-medium">{attempt.role}</span>
                            <span>{attempt.provider}</span>
                            <span>{attempt.status}</span>
                          </div>
                          <p className="mt-1 text-[0.68rem] text-muted-foreground">
                            {attempt.selectionReason}
                            {attempt.errorCode
                              ? ` · ${attempt.errorCode}`
                              : ""}
                          </p>
                        </div>
                      ))}
                      {artifacts.attempts.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          尚无 Provider attempt。
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <div className="rounded-lg border border-border/70 p-3">
                    <p className="text-xs font-medium">
                      Reports · {artifacts.reports.length}
                    </p>
                    <div className="mt-2 space-y-2">
                      {artifacts.reports.map((report) => (
                        <div
                          key={report.reportId}
                          className="[content-visibility:auto] rounded-md bg-muted/45 p-2"
                        >
                          <p className="text-xs font-medium">
                            {report.role} · {report.provider}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {report.summary}
                          </p>
                          <p className="mt-1 text-[0.68rem] text-muted-foreground">
                            visible reports: {report.visibleReportIds.length}
                          </p>
                        </div>
                      ))}
                      {artifacts.reports.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          尚无完整报告。
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <div className="rounded-lg border border-border/70 p-3">
                    <p className="text-xs font-medium">
                      Claims · {artifacts.claims.length}
                    </p>
                    <div className="mt-2 space-y-2">
                      {artifacts.claims.map((claim) => {
                        const novelty = artifacts.novelty.find(
                          (item) => item.claimId === claim.claimId,
                        );
                        return (
                          <div
                            key={claim.claimId}
                            className="[content-visibility:auto] rounded-md bg-muted/45 p-2"
                          >
                            <div className="flex flex-wrap items-center gap-2 text-xs">
                              <span className="font-medium">
                                {claim.topicKey}
                              </span>
                              <span>{claim.status}</span>
                              {novelty ? <span>{novelty.novelty}</span> : null}
                            </div>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {claim.statement}
                            </p>
                          </div>
                        );
                      })}
                      {artifacts.claims.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          尚无 Claim；空证据或未完成 Run 不会生成模拟结论。
                        </p>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="mt-3 rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                正在读取该 Run 的分析产物。
              </div>
            )}

          </>
        ) : (
          <div className="rounded-lg border border-dashed border-border p-5 text-sm text-muted-foreground">
            该学习范围暂无分析 Run；下方仍会展示 Agent Team
            已真实记录的激活轨迹。
          </div>
        )}

        <div className={selectedRun ? "mt-6" : "mt-5"}>
          <h3 className="font-semibold">RuntimeTrace</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            按当前学习范围展示真实 Agent Team 激活、门禁与完成事件
          </p>
        </div>
        <div className="mt-3 space-y-2">
          {traces.length > 0 ? (
            traces.map((trace) => (
              <div
                key={trace.traceId}
                className="rounded-lg border border-border/70 bg-background/45 p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-mono text-xs">{trace.traceId}</p>
                  <EvolutionStatusPill
                    status={
                      trace.assignmentBucket === "canary" ? "canary" : "draft"
                    }
                    label={trace.assignmentBucket}
                  />
                </div>
                <p className="mt-2 break-all text-xs text-muted-foreground">
                  run {trace.runId} · dispatch {trace.dispatchId} ·{" "}
                  {trace.exposedRevisionIds.length} exposed
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {trace.events.map((event) => (
                    <span
                      key={event.eventId}
                      className="rounded bg-muted px-1.5 py-0.5 text-[0.68rem] text-muted-foreground"
                    >
                      {event.kind}
                    </span>
                  ))}
                </div>
                <div className="mt-2 flex items-center justify-between gap-2">
                  {trace.failOpenReason ? (
                    <p className="text-xs text-amber-600">
                      fail-open: {trace.failOpenReason}
                    </p>
                  ) : (
                    <span />
                  )}
                  <Button variant="ghost" size="sm" asChild>
                    <Link
                      to={`/activity?view=facts&search=${encodeURIComponent(trace.runId)}`}
                    >
                      <Activity className="h-4 w-4" />
                      Activity 证据
                    </Link>
                  </Button>
                </div>
              </div>
            ))
          ) : (
            <div className="rounded-lg border border-dashed border-border p-5 text-sm text-muted-foreground">
              该学习范围暂无 RuntimeTrace。纯分析不会自动生成模拟激活轨迹。
            </div>
          )}
        </div>
      </EvolutionPanel>
    </div>
  );
}

function ReflectionResult({
  artifacts,
}: {
  artifacts: EvolutionRunArtifacts;
}) {
  const activitySource = artifacts.contextPack?.sources.find(
    (source) => source.source === "activity",
  );
  const workspaceCount = new Set(
    artifacts.contextPack?.evidence.flatMap((evidence) =>
      evidence.source === "activity" && evidence.origin.projectId
        ? [evidence.origin.projectId]
        : [],
    ) ?? [],
  ).size;
  const recommendations = artifacts.claims.filter(
    (claim) => claim.status === "corroborated" && claim.guidance,
  );
  const contested = artifacts.claims.filter(
    (claim) => claim.status === "contested",
  );

  return (
    <section className="mt-6 rounded-xl border border-primary/20 bg-primary/[0.04] p-4">
      <div className="flex items-center gap-2">
        <Lightbulb className="h-4 w-4 text-amber-500" />
        <h3 className="font-semibold">本次复盘结论</h3>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg bg-background/80 p-3">
          <p className="text-xs text-muted-foreground">覆盖数据</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">
            {activitySource?.recordCount ?? 0} 条
          </p>
        </div>
        <div className="rounded-lg bg-background/80 p-3">
          <p className="text-xs text-muted-foreground">涉及工作区</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">
            {workspaceCount} 个
          </p>
        </div>
        <div className="rounded-lg bg-background/80 p-3">
          <p className="text-xs text-muted-foreground">数据范围</p>
          <p className="mt-1 text-sm font-medium">
            {activitySource?.afterWatermark === "0"
              ? "首次复盘至当前"
              : "上次成功复盘至当前"}
          </p>
          <p className="mt-1 text-[0.68rem] text-muted-foreground">
            {activitySource?.truncated
              ? "仍有未处理数据"
              : "冻结范围已全部覆盖"}
          </p>
        </div>
      </div>

      <div className="mt-4">
        <p className="text-sm font-medium">关键决策与优化建议</p>
        {recommendations.length > 0 ? (
          <div className="mt-2 space-y-2">
            {recommendations.map((claim) => (
              <article
                key={claim.claimId}
                className="rounded-lg bg-background/80 p-3"
              >
                <p className="text-sm font-medium">{claim.statement}</p>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  {claim.guidance}
                </p>
              </article>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            当前没有经过交叉验证的新优化建议。
          </p>
        )}
      </div>

      {contested.length > 0 ? (
        <p className="mt-3 text-xs text-amber-700 dark:text-amber-200">
          另有 {contested.length} 项判断仍存在分歧，已保留证据等待后续验证。
        </p>
      ) : null}
    </section>
  );
}

function summarizeDataQuality(
  issues: NonNullable<
    EvolutionRunArtifacts["contextPack"]
  >["dataQualityIssues"],
): Array<{ code: string; count: number; detail: string }> {
  const summaries = new Map<
    string,
    { code: string; count: number; detail: string }
  >();
  for (const issue of issues) {
    const existing = summaries.get(issue.code);
    if (existing) {
      existing.count += 1;
    } else {
      summaries.set(issue.code, {
        code: issue.code,
        count: 1,
        detail: issue.detail,
      });
    }
  }
  return Array.from(summaries.values()).sort(
    (left, right) =>
      right.count - left.count || left.code.localeCompare(right.code),
  );
}
