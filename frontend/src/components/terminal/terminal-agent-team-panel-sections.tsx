import { AlertTriangle, Play, Plus, RotateCcw, X } from "lucide-react";
import type { AgentTeamRun } from "@runweave/shared/agent-team";
import { Button } from "../ui/button";
import {
  getAgentTeamCaseElementId,
  ROLE_CYCLE,
  ROLE_LABEL,
  type WorkerDraft,
} from "./terminal-agent-team-panel-model";
import { AcceptanceEvidenceDetails } from "./terminal-agent-team-panel-details";

export function StartFlowSection({
  mode = "start",
  task,
  planFilePath,
  testCaseFilePath,
  reviewCheckpointEnabled,
  busy,
  onTaskChange,
  onPlanFilePathChange,
  onTestCaseFilePathChange,
  onReviewCheckpointEnabledChange,
  onStart,
}: {
  mode?: "start" | "retry";
  task: string;
  planFilePath: string;
  testCaseFilePath: string;
  reviewCheckpointEnabled: boolean;
  busy: boolean;
  onTaskChange: (value: string) => void;
  onPlanFilePathChange: (value: string) => void;
  onTestCaseFilePathChange: (value: string) => void;
  onReviewCheckpointEnabledChange: (value: boolean) => void;
  onStart: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="text-sm font-medium text-slate-200">
        {mode === "retry" ? "重新开始 Agent Team" : "这是一个普通终端"}
      </div>
      <p className="text-xs leading-relaxed text-slate-400">
        {mode === "retry" ? (
          "已回填上一次任务参数。提交后会创建新的 Run，原失败记录会保留。"
        ) : (
          <>
            当前是标准 shell 会话，没有多 Agent 流程。提交任务后，Agent Team 会进入
            <code className="mx-1 rounded bg-slate-800 px-1">
              拆分提案 → 执行观测
            </code>
            。
          </>
        )}
      </p>
      <ol className="space-y-1 pl-4 text-xs text-slate-400 [list-style:decimal]">
        <li>服务端自动生成并确认 worker 拆分</li>
        <li>
          自动 split 出 worker pane，并按 code → review → verify 串行门禁推进
        </li>
      </ol>
      <div className="rounded border border-slate-800 bg-slate-900/50 px-2 py-1.5 text-[11px] leading-relaxed text-slate-400">
        拆分策略：服务端自动拆分。右侧面板只展示状态与日志，不需要手动点击“拆分”。
      </div>
      <label className="block space-y-1 text-[11px] text-slate-400">
        <span>计划文件</span>
        <input
          className="h-8 w-full rounded border border-slate-800 bg-slate-950 px-2 text-xs text-slate-100 outline-none placeholder:text-slate-500 focus:border-sky-600"
          value={planFilePath}
          onChange={(event) => onPlanFilePathChange(event.target.value)}
          placeholder="docs/plans/example.md"
        />
      </label>
      <label className="flex items-start gap-2 rounded border border-slate-800 bg-slate-900/50 p-2 text-[11px] text-slate-300">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={reviewCheckpointEnabled}
          onChange={(event) =>
            onReviewCheckpointEnabledChange(event.target.checked)
          }
        />
        <span>
          <span className="block font-medium text-slate-200">
            Review 通过后创建本地 checkpoint commit
          </span>
          <span className="mt-0.5 block text-slate-500">
            要求干净 Git worktree；创建专用本地分支，不会自动 push、squash
            或发布。
          </span>
        </span>
      </label>
      <label className="block space-y-1 text-[11px] text-slate-400">
        <span>测试案例文件</span>
        <input
          className="h-8 w-full rounded border border-slate-800 bg-slate-950 px-2 text-xs text-slate-100 outline-none placeholder:text-slate-500 focus:border-sky-600"
          value={testCaseFilePath}
          onChange={(event) => onTestCaseFilePathChange(event.target.value)}
          placeholder="docs/testing/example-test-cases.md"
        />
      </label>
      <textarea
        className="min-h-20 w-full resize-y rounded border border-slate-800 bg-slate-950 px-2 py-1.5 text-xs text-slate-100 outline-none placeholder:text-slate-500 focus:border-sky-600"
        value={task}
        onChange={(event) => onTaskChange(event.target.value)}
        placeholder="描述要执行的任务"
      />
      <Button
        type="button"
        size="sm"
        className="w-full"
        disabled={busy || !task.trim()}
        onClick={onStart}
      >
        <Play className="h-4 w-4" />
        {mode === "retry" ? "重新开始 Agent Team" : "开始 Agent Team"}
      </Button>
    </div>
  );
}

export function FailedRunSection({
  run,
  busy,
  onRetry,
}: {
  run: AgentTeamRun;
  busy: boolean;
  onRetry: () => void;
}) {
  const recentLogs = run.logs.slice(-5).reverse();
  return (
    <div className="space-y-3">
      <div className="rounded border border-rose-800 bg-rose-950/40 p-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-rose-300">
          <AlertTriangle className="h-4 w-4" /> Agent Team 执行失败
        </div>
        <p className="mt-1 whitespace-pre-wrap break-words text-[11px] text-rose-200">
          {run.logs.at(-1) ?? "Agent Team 未能完成当前 Run。"}
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        className="w-full"
        disabled={busy}
        onClick={onRetry}
      >
        <RotateCcw className="h-4 w-4" /> 修改参数并重试
      </Button>
      <div>
        <div className="mb-1 text-xs font-semibold text-slate-400">Log</div>
        <div className="space-y-0.5 rounded border border-slate-800 bg-slate-950/60 p-2 font-mono text-[10px] text-slate-400">
          {recentLogs.map((line, index) => (
            <div key={`${index}-${line}`}>{line}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ProposalSection({
  run,
  workerDrafts,
  busy,
  onChangeDrafts,
  onConfirm,
  onReject,
}: {
  run: AgentTeamRun;
  workerDrafts: WorkerDraft[];
  busy: boolean;
  onChangeDrafts: (drafts: WorkerDraft[]) => void;
  onConfirm: () => void;
  onReject: () => void;
}) {
  const splitManagedByServer = run.options.autoApproveSplit;
  const canEditSplit = !splitManagedByServer && run.workers.length === 0;
  const recentLogs = run.logs.slice(-5).reverse();
  const removeWorker = (index: number) => {
    if (!canEditSplit) {
      return;
    }
    onChangeDrafts(workerDrafts.filter((_, current) => current !== index));
  };
  const addWorker = () => {
    if (!canEditSplit) {
      return;
    }
    const nextRole = ROLE_CYCLE[workerDrafts.length % ROLE_CYCLE.length]!;
    onChangeDrafts([
      ...workerDrafts,
      { role: nextRole, intent: `${ROLE_LABEL[nextRole]} worker（人工新增）` },
    ]);
  };
  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold uppercase text-slate-400">
        Worker 拆分提案
      </h3>
      <p className="text-xs text-slate-400">{run.proposal?.summary}</p>
      <div className="space-y-2">
        {workerDrafts.map((worker, index) => (
          <div
            key={index}
            className="flex items-center gap-2 rounded border border-slate-800 bg-slate-900/60 px-2 py-1.5"
          >
            <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-300">
              {ROLE_LABEL[worker.role]}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-slate-300">
              {worker.intent}
            </span>
            {canEditSplit ? (
              <button
                type="button"
                className="text-slate-500 hover:text-rose-400"
                onClick={() => removeWorker(index)}
                aria-label="移除 worker"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        ))}
      </div>
      {canEditSplit ? (
        <button
          type="button"
          className="flex w-full items-center justify-center gap-1 rounded border border-dashed border-slate-700 py-1.5 text-xs text-slate-400 hover:text-slate-200"
          onClick={addWorker}
        >
          <Plus className="h-3.5 w-3.5" /> 加一个 worker
        </button>
      ) : null}

      {run.proposal && run.proposal.acceptance.length > 0 ? (
        <div className="rounded border border-slate-800 bg-slate-900/40 p-2">
          <div className="mb-1 text-[11px] font-semibold text-slate-300">
            验收用例草案
          </div>
          <div className="mb-1 text-[10px] text-sky-300">
            {formatVerificationSource(run)}
          </div>
          <p className="mb-1 text-[10px] text-slate-500">
            Agent Team 把任务目标落成可观测验收用例，由 behavior_verify worker
            跑。
            {splitManagedByServer
              ? "由服务端随拆分自动确认。"
              : "与拆分一并确认。"}
          </p>
          <ol className="space-y-0.5 pl-4 text-[11px] text-slate-400 [list-style:decimal]">
            {run.proposal.acceptance.map((item) => (
              <li key={item.caseId}>
                <span className="font-mono text-slate-300">
                  {item.sourceCaseId ?? item.caseId}
                </span>
                <span className="ml-1 whitespace-pre-wrap break-words">
                  {item.text}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {canEditSplit ? (
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            className="flex-1"
            disabled={busy || workerDrafts.length === 0}
            onClick={onConfirm}
          >
            确认拆分 · split {workerDrafts.length} 个 pane →
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={onReject}
          >
            驳回
          </Button>
        </div>
      ) : (
        <div className="rounded border border-slate-800 bg-slate-900/50 px-2 py-1.5 text-[11px] leading-relaxed text-slate-400">
          服务端正在自动确认拆分并创建 worker pane。这里不再提供手动拆分入口。
        </div>
      )}

      <div>
        <div className="mb-1 text-xs font-semibold text-slate-400">Log</div>
        <div className="space-y-0.5 rounded border border-slate-800 bg-slate-950/60 p-2 font-mono text-[10px] text-slate-400">
          {recentLogs.length > 0 ? (
            recentLogs.map((line, index) => (
              <div key={`${index}-${line}`}>{line}</div>
            ))
          ) : (
            <div>等待服务端自动拆分...</div>
          )}
        </div>
      </div>
    </div>
  );
}

export function ExecutingSection({
  apiBase,
  token,
  projectId,
  run,
  busy,
  onRetry,
  onAuthExpired,
}: {
  apiBase: string;
  token: string;
  projectId: string;
  run: AgentTeamRun;
  busy: boolean;
  onRetry: () => void;
  onAuthExpired?: () => void;
}) {
  const { loop, acceptance } = run;
  const ratio =
    loop.maxNoProgress > 0 ? loop.noProgressCount / loop.maxNoProgress : 0;
  const level = loop.escalated ? "escalated" : ratio >= 0.66 ? "warn" : "ok";
  const passed = acceptance.filter((item) => item.status === "pass").length;
  const failed = acceptance.filter((item) => item.status === "fail").length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase text-slate-400">
          Loop 状态
        </h3>
        <span className="rounded border border-slate-700 px-1.5 py-0.5 text-[9px] uppercase text-slate-500">
          {run.activeWorkerRole
            ? ROLE_LABEL[run.activeWorkerRole]
            : "Observe Only"}
        </span>
      </div>

      {run.reviewCheckpoint ? <ReviewCheckpointStatus run={run} /> : null}

      {(run.findingDecisions ?? []).length > 0 ? (
        <div className="rounded border border-sky-900 bg-sky-950/25 p-2 text-[10px] text-sky-200">
          <div className="font-semibold uppercase text-sky-400">
            Finding 裁决记录
          </div>
          {(run.findingDecisions ?? []).slice(-3).map((decision) => (
            <div key={decision.id} className="mt-1 break-words">
              <span className="font-mono">{decision.invariantKey}</span> ·{" "}
              {formatFindingDisposition(decision.disposition)}
              {decision.caseIds.length > 0
                ? ` · ${decision.caseIds.join(", ")}`
                : ""}
              <span className="block text-sky-100/80">
                {decision.finding.severity} · {decision.finding.title}
              </span>
              <span className="block text-sky-300/60">{decision.reason}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div
        className={[
          "rounded border p-2",
          level === "escalated"
            ? "border-rose-800 bg-rose-950/40"
            : level === "warn"
              ? "border-amber-800 bg-amber-950/30"
              : "border-slate-800 bg-slate-900/40",
        ].join(" ")}
      >
        <div className="flex items-center justify-between text-xs text-slate-300">
          <span>轮次</span>
          <span>round {loop.round}</span>
        </div>
        <div className="flex items-center justify-between text-xs text-slate-300">
          <span>无进展</span>
          <span>
            {loop.noProgressCount} / {loop.maxNoProgress}
          </span>
        </div>
        <div className="mt-1.5 flex gap-1">
          {Array.from({ length: loop.maxNoProgress }).map((_, index) => (
            <span
              key={index}
              className={[
                "h-1.5 flex-1 rounded",
                index < loop.noProgressCount
                  ? level === "escalated"
                    ? "bg-rose-500"
                    : "bg-amber-400"
                  : "bg-slate-700",
              ].join(" ")}
            />
          ))}
        </div>
      </div>

      {run.pendingFindingDecision ? (
        <div className="rounded border border-rose-800 bg-rose-950/40 p-2 text-[11px] text-rose-200">
          Loop 已暂停。请在顶部完成 Finding
          范围裁决；这里不会提供通用“人工完成”入口。
        </div>
      ) : run.status === "done" ? (
        <div className="rounded border border-emerald-900 bg-emerald-950/30 p-2 text-xs text-emerald-300">
          Loop 已完成，worker pane 已冻结。
        </div>
      ) : run.status === "failed" ? (
        <div className="space-y-2 rounded border border-rose-800 bg-rose-950/40 p-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-rose-300">
            <AlertTriangle className="h-4 w-4" /> Agent Team 执行失败
          </div>
          <p className="text-[11px] text-rose-200">
            {run.logs.at(-1) ?? "Agent Team 未能完成当前 Run。"}
          </p>
          <Button
            type="button"
            size="sm"
            className="w-full"
            disabled={busy}
            onClick={onRetry}
          >
            <RotateCcw className="h-4 w-4" /> 修改参数并重试
          </Button>
        </div>
      ) : null}

      <div>
        <div className="mb-1 flex items-center justify-between text-xs font-semibold text-slate-400">
          <span>验收用例 + 证据</span>
          <span className="text-[10px] text-slate-500">
            {passed}✓{failed > 0 ? ` ${failed}✗` : ""}
          </span>
        </div>
        <div className="mb-1 text-[10px] text-sky-300">
          {formatVerificationSource(run)}
        </div>
        <div className="space-y-1.5">
          {acceptance.map((item) => (
            <div
              key={item.caseId}
              id={getAgentTeamCaseElementId(run.runId, item.caseId)}
              tabIndex={-1}
              className={[
                "rounded border px-2 py-1.5 text-[11px] outline-none focus:ring-1 focus:ring-amber-400",
                item.status === "pass"
                  ? "border-emerald-900 bg-emerald-950/30"
                  : item.status === "fail"
                    ? "border-rose-900 bg-rose-950/30"
                    : "border-slate-800 bg-slate-900/40",
              ].join(" ")}
            >
              <div className="flex items-start gap-1.5">
                <span
                  className={
                    item.status === "pass"
                      ? "text-emerald-400"
                      : item.status === "fail"
                        ? "text-rose-400"
                        : "text-slate-500"
                  }
                >
                  {item.status === "pass"
                    ? "✓"
                    : item.status === "fail"
                      ? "✗"
                      : "•"}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[10px] text-slate-500">
                    {item.sourceCaseId ?? item.caseId}
                  </div>
                  <div className="whitespace-pre-wrap break-words text-slate-300">
                    {item.text}
                  </div>
                  {item.sourceFilePath ? (
                    <div className="mt-0.5 text-[10px] text-slate-500">
                      来源：{item.sourceFilePath}
                    </div>
                  ) : null}
                  {item.skipReason ? (
                    <div className="mt-0.5 text-[10px] text-slate-500">
                      跳过：{item.skipReason}
                    </div>
                  ) : null}
                  <AcceptanceEvidenceDetails
                    apiBase={apiBase}
                    token={token}
                    projectId={projectId}
                    status={item.status}
                    summary={item.resultSummary}
                    evidence={item.evidence}
                    onAuthExpired={onAuthExpired}
                  />
                  {item.status === "fail" && item.bouncedToPanelId ? (
                    <div className="mt-0.5 text-[10px] text-amber-400">
                      → 已抛回 code pane 修复
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-1 text-xs font-semibold text-slate-400">Log</div>
        <div className="space-y-0.5 rounded border border-slate-800 bg-slate-950/60 p-2 font-mono text-[10px] text-slate-400">
          {run.logs
            .slice()
            .reverse()
            .map((line, index) => (
              <div key={`${index}-${line}`}>{line}</div>
            ))}
        </div>
      </div>
    </div>
  );
}

function formatFindingDisposition(
  disposition: "blocking" | "out_of_scope" | "waived",
): string {
  if (disposition === "blocking") {
    return "继续修复";
  }
  return disposition === "out_of_scope" ? "范围外" : "本轮豁免";
}

function ReviewCheckpointStatus({ run }: { run: AgentTeamRun }) {
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

function formatVerificationSource(run: AgentTeamRun): string {
  const verification = run.verification;
  if (!verification) {
    return "来源：未记录";
  }
  const source =
    verification.acceptanceSource === "test_case_file"
      ? "测试案例文件"
      : verification.acceptanceSource === "plan_file_generated"
        ? "计划文件生成"
        : "任务描述生成";
  const filePath =
    verification.testCaseFilePath ??
    verification.generatedTestCaseFilePath ??
    verification.planFilePath ??
    "等待生成 docs/testing 测试案例文件";
  return `来源：${source} ${filePath}`;
}
