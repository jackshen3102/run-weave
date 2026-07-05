import { AlertTriangle, Crosshair, Play, Plus, X } from "lucide-react";
import type {
  AgentTeamAcceptanceEvidence,
  AgentTeamAcceptanceStatus,
  AgentTeamRun,
} from "@runweave/shared";
import { Button } from "../ui/button";
import {
  ROLE_CYCLE,
  ROLE_LABEL,
  type WorkerDraft,
} from "./terminal-agent-team-panel-model";

const EVIDENCE_TYPE_LABEL: Record<AgentTeamAcceptanceEvidence["type"], string> =
  {
    text: "文本",
    dom: "DOM",
    screenshot: "截图",
    command: "命令",
    event: "事件",
    json: "JSON",
    log: "日志",
    code: "代码",
  };

const EVIDENCE_ATTACHMENT_LABEL: Partial<
  Record<AgentTeamAcceptanceEvidence["type"], string>
> = {
  screenshot: "查看截图",
  dom: "查看 DOM 证据",
  json: "查看 JSON 证据",
  log: "查看日志证据",
  code: "查看代码证据",
  command: "查看命令记录",
  event: "查看事件记录",
};

export function StartFlowSection({
  task,
  planFile,
  autoApproveSplit,
  busy,
  onTaskChange,
  onPlanFileChange,
  onToggleAutoApprove,
  onStart,
}: {
  task: string;
  planFile: string;
  autoApproveSplit: boolean;
  busy: boolean;
  onTaskChange: (value: string) => void;
  onPlanFileChange: (value: string) => void;
  onToggleAutoApprove: () => void;
  onStart: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="text-sm font-medium text-slate-200">这是一个普通终端</div>
      <p className="text-xs leading-relaxed text-slate-400">
        当前是标准 shell 会话，没有多 Agent 流程。提交任务后，Agent Team 会进入
        <code className="mx-1 rounded bg-slate-800 px-1">
          计划审查（可选）→ 拆分提案 → 执行观测
        </code>
        。
      </p>
      <ol className="space-y-1 pl-4 text-xs text-slate-400 [list-style:decimal]">
        <li>可选计划文件先由 plan_review 审查</li>
        <li>计划通过后产出 worker 拆分提案，你确认</li>
        <li>确认后 split 出 worker pane，并按 code → review → verify 串行门禁推进</li>
      </ol>
      <textarea
        className="min-h-20 w-full resize-y rounded border border-slate-800 bg-slate-950 px-2 py-1.5 text-xs text-slate-100 outline-none placeholder:text-slate-500 focus:border-sky-600"
        value={task}
        onChange={(event) => onTaskChange(event.target.value)}
        placeholder="描述要执行的任务"
      />
      <input
        className="w-full rounded border border-slate-800 bg-slate-950 px-2 py-1.5 text-xs text-slate-100 outline-none placeholder:text-slate-500 focus:border-sky-600"
        value={planFile}
        onChange={(event) => onPlanFileChange(event.target.value)}
        placeholder="可选：计划文件路径，如 docs/plans/xxx.md"
      />
      <label className="flex items-center gap-2 text-xs text-slate-300">
        <input
          type="checkbox"
          checked={autoApproveSplit}
          onChange={onToggleAutoApprove}
          className="h-3.5 w-3.5"
        />
        自动确认拆分（跳过人工门）
      </label>
      <Button
        type="button"
        size="sm"
        className="w-full"
        disabled={busy || !task.trim()}
        onClick={onStart}
      >
        <Play className="h-4 w-4" /> 开始 Agent Team
      </Button>
    </div>
  );
}

export function PlanReviewSection({
  run,
  busy,
  resumeNote,
  onResumeNoteChange,
  onResume,
  onFocusPane,
}: {
  run: AgentTeamRun;
  busy: boolean;
  resumeNote: string;
  onResumeNoteChange: (value: string) => void;
  onResume: () => void;
  onFocusPane: (panelId: string) => void;
}) {
  const { loop, acceptance } = run;
  const ratio =
    loop.maxNoProgress > 0 ? loop.noProgressCount / loop.maxNoProgress : 0;
  const level = loop.escalated ? "escalated" : ratio >= 0.66 ? "warn" : "ok";
  const passed = acceptance.filter((item) => item.status === "pass").length;
  const failed = acceptance.filter((item) => item.status === "fail").length;

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-xs font-semibold uppercase text-slate-400">
          计划审查
        </h3>
        <div className="mt-1 rounded border border-slate-800 bg-slate-900/40 px-2 py-1.5 text-[11px] text-slate-300">
          {run.planFile}
        </div>
        <div className="mt-1 text-[10px] text-slate-500">
          当前门禁：{run.activeWorkerRole ? ROLE_LABEL[run.activeWorkerRole] : "无"}
        </div>
      </div>
      <ScopeSnapshotDetails run={run} />

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
          <span>修复轮次</span>
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

      {loop.escalated ? (
        <div className="space-y-2 rounded border border-rose-800 bg-rose-950/40 p-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-rose-300">
            <AlertTriangle className="h-4 w-4" /> 计划修复无进展
          </div>
          <p className="text-[11px] text-rose-200">{loop.lastReason}</p>
          <PaneFocusList run={run} onFocusPane={onFocusPane} />
          <textarea
            className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-200"
            rows={2}
            placeholder="填写人工干预 note"
            value={resumeNote}
            onChange={(event) => onResumeNoteChange(event.target.value)}
          />
          <Button
            type="button"
            size="sm"
            className="w-full"
            disabled={busy || !resumeNote.trim()}
            onClick={onResume}
          >
            人工已介入 · 恢复计划 loop →
          </Button>
        </div>
      ) : null}

      <div>
        <div className="mb-1 flex items-center justify-between text-xs font-semibold text-slate-400">
          <span>审查用例 + 证据</span>
          <span className="text-[10px] text-slate-500">
            {passed}✓{failed > 0 ? ` ${failed}✗` : ""}
          </span>
        </div>
        <div className="space-y-1.5">
          {acceptance.map((item) => (
            <div
              key={item.caseId}
              className={[
                "rounded border px-2 py-1.5 text-[11px]",
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
                  <div className="text-slate-300">{item.text}</div>
                  <AcceptanceEvidenceDetails
                    status={item.status}
                    evidence={item.evidence}
                  />
                  {item.status === "fail" && item.bouncedToPanelId ? (
                    <div className="mt-0.5 text-[10px] text-amber-400">
                      → 已抛回 plan worker 修复
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
  const removeWorker = (index: number) => {
    onChangeDrafts(workerDrafts.filter((_, current) => current !== index));
  };
  const addWorker = () => {
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
            <button
              type="button"
              className="text-slate-500 hover:text-rose-400"
              onClick={() => removeWorker(index)}
              aria-label="移除 worker"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="flex w-full items-center justify-center gap-1 rounded border border-dashed border-slate-700 py-1.5 text-xs text-slate-400 hover:text-slate-200"
        onClick={addWorker}
      >
        <Plus className="h-3.5 w-3.5" /> 加一个 worker
      </button>

      {run.proposal && run.proposal.acceptance.length > 0 ? (
        <div className="rounded border border-slate-800 bg-slate-900/40 p-2">
          <div className="mb-1 text-[11px] font-semibold text-slate-300">
            验收用例草案
          </div>
          <p className="mb-1 text-[10px] text-slate-500">
            Agent Team 把任务目标落成可观测验收用例，由 behavior_verify worker
            跑。与拆分一并确认。
          </p>
          <ol className="space-y-0.5 pl-4 text-[11px] text-slate-400 [list-style:decimal]">
            {run.proposal.acceptance.map((item) => (
              <li key={item.caseId}>{item.text}</li>
            ))}
          </ol>
        </div>
      ) : null}

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
    </div>
  );
}

export function ExecutingSection({
  run,
  busy,
  resumeNote,
  onResumeNoteChange,
  onRecordRound,
  onResume,
  onComplete,
  onFocusPane,
}: {
  run: AgentTeamRun;
  busy: boolean;
  resumeNote: string;
  onResumeNoteChange: (value: string) => void;
  onRecordRound: (hadProgress: boolean) => void;
  onResume: () => void;
  onComplete: () => void;
  onFocusPane: (panelId: string) => void;
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
          {run.activeWorkerRole ? ROLE_LABEL[run.activeWorkerRole] : "Observe Only"}
        </span>
      </div>

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
      <ScopeSnapshotDetails run={run} />

      {loop.escalated ? (
        <div className="space-y-2 rounded border border-rose-800 bg-rose-950/40 p-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-rose-300">
            <AlertTriangle className="h-4 w-4" /> 已熔断 · 升级人工
          </div>
          <p className="text-[11px] text-rose-200">{loop.lastReason}</p>
          <PaneFocusList run={run} onFocusPane={onFocusPane} />
          <textarea
            className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-200"
            rows={2}
            placeholder="填写人工干预 note（恢复时注入主 Agent；完成时作为记录保存）"
            value={resumeNote}
            onChange={(event) => onResumeNoteChange(event.target.value)}
          />
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              className="flex-1"
              disabled={busy || !resumeNote.trim()}
              onClick={onResume}
            >
              人工已介入 · 恢复 loop →
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="flex-1 border-emerald-800 text-emerald-300 hover:bg-emerald-950/40 hover:text-emerald-200"
              disabled={busy}
              onClick={onComplete}
            >
              人工确认完成
            </Button>
          </div>
        </div>
      ) : run.status === "done" ? (
        <div className="rounded border border-emerald-900 bg-emerald-950/30 p-2 text-xs text-emerald-300">
          Loop 已完成，worker pane 已冻结。
        </div>
      ) : (
        <details className="group rounded border border-slate-800 bg-slate-900/40 p-2">
          <summary className="cursor-pointer select-none text-[10px] font-medium uppercase text-slate-500 hover:text-slate-300">
            Debug
          </summary>
          <div className="mt-2 text-[10px] text-slate-500">
            模拟 loop 反馈（连续 {loop.maxNoProgress} 轮无进展将自动熔断）：
          </div>
          <div className="mt-1 flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="flex-1 border-emerald-800 text-emerald-300"
              disabled={busy}
              onClick={() => onRecordRound(true)}
            >
              ✓ 有进展的一轮
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="flex-1 border-rose-800 text-rose-300"
              disabled={busy}
              onClick={() => onRecordRound(false)}
            >
              ✗ 无进展的一轮
            </Button>
          </div>
        </details>
      )}

      <div>
        <div className="mb-1 flex items-center justify-between text-xs font-semibold text-slate-400">
          <span>验收用例 + 证据</span>
          <span className="text-[10px] text-slate-500">
            {passed}✓{failed > 0 ? ` ${failed}✗` : ""}
          </span>
        </div>
        <div className="space-y-1.5">
          {acceptance.map((item) => (
            <div
              key={item.caseId}
              className={[
                "rounded border px-2 py-1.5 text-[11px]",
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
                  <div className="text-slate-300">{item.text}</div>
                  <AcceptanceEvidenceDetails
                    status={item.status}
                    evidence={item.evidence}
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

function AcceptanceEvidenceDetails({
  status,
  evidence,
}: {
  status: AgentTeamAcceptanceStatus;
  evidence: AgentTeamAcceptanceEvidence[];
}) {
  const leadSummary = evidence[0]?.summary;
  const conclusion = leadSummary
    ? `${getStatusPrefix(status)}：${leadSummary}`
    : `${getStatusPrefix(status)}：尚未收到证据`;
  const groupedEvidence = groupEvidenceByType(evidence);

  return (
    <div className="mt-1 space-y-1 text-[10px]">
      <div
        className={[
          "leading-relaxed",
          status === "pass"
            ? "text-emerald-300"
            : status === "fail"
              ? "text-rose-300"
              : "text-slate-500",
        ].join(" ")}
      >
        {conclusion}
      </div>
      {evidence.length > 0 ? (
        <details className="border-t border-slate-800 pt-1">
          <summary className="cursor-pointer select-none text-slate-500 hover:text-slate-300">
            {evidence.length} 条证据
          </summary>
          <div className="mt-1 space-y-2">
            {groupedEvidence.map(([type, items]) => (
              <div key={type} className="space-y-1">
                <div className="font-medium text-slate-400">
                  {EVIDENCE_TYPE_LABEL[type]}
                </div>
                <div className="space-y-1">
                  {items.map((item, index) => (
                    <div
                      key={`${item.type}-${item.label}-${index}`}
                      className="border-l border-slate-700 pl-2"
                    >
                      <div className="font-medium text-slate-300">
                        {item.label}
                      </div>
                      <div className="leading-relaxed text-slate-400">
                        {item.summary}
                      </div>
                      {item.detail ? (
                        <div className="mt-0.5 leading-relaxed text-slate-500">
                          {item.detail}
                        </div>
                      ) : null}
                      <details className="mt-0.5">
                        <summary
                          className="inline cursor-pointer select-none text-sky-300 hover:text-sky-200"
                          title={item.ref}
                        >
                          {getEvidenceAttachmentLabel(item)}
                        </summary>
                        <div className="mt-0.5 break-all font-mono text-slate-500">
                          {item.ref}
                        </div>
                      </details>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function groupEvidenceByType(
  evidence: AgentTeamAcceptanceEvidence[],
): Array<[AgentTeamAcceptanceEvidence["type"], AgentTeamAcceptanceEvidence[]]> {
  const groups = new Map<
    AgentTeamAcceptanceEvidence["type"],
    AgentTeamAcceptanceEvidence[]
  >();
  for (const item of evidence) {
    groups.set(item.type, [...(groups.get(item.type) ?? []), item]);
  }
  return Array.from(groups.entries());
}

function getStatusPrefix(status: AgentTeamAcceptanceStatus): string {
  if (status === "pass") {
    return "已通过";
  }
  if (status === "fail") {
    return "未通过";
  }
  return "待验收";
}

function getEvidenceAttachmentLabel(
  evidence: AgentTeamAcceptanceEvidence,
): string {
  return EVIDENCE_ATTACHMENT_LABEL[evidence.type] ?? "查看原始证据";
}

function ScopeSnapshotDetails({ run }: { run: AgentTeamRun }) {
  const snapshot = run.scopeSnapshot;
  if (!snapshot) {
    return null;
  }
  const lines = snapshot.gitStatusShort;
  return (
    <details className="group rounded border border-slate-800 bg-slate-900/40 p-2">
      <summary className="cursor-pointer select-none text-[10px] font-medium uppercase text-slate-500 hover:text-slate-300">
        Scope Snapshot · {lines.length} dirty paths
      </summary>
      <div className="mt-2 space-y-1 text-[10px] text-slate-400">
        <div>capturedAt: {snapshot.capturedAt}</div>
        {snapshot.error ? (
          <div className="text-amber-300">capture error: {snapshot.error}</div>
        ) : null}
        {lines.length > 0 ? (
          <pre className="max-h-28 overflow-auto whitespace-pre-wrap rounded bg-slate-950/70 p-2 font-mono text-[10px] text-slate-300">
            {lines.join("\n")}
          </pre>
        ) : (
          <div className="text-slate-500">git status clean at run start</div>
        )}
      </div>
    </details>
  );
}

function PaneFocusList({
  run,
  onFocusPane,
}: {
  run: AgentTeamRun;
  onFocusPane: (panelId: string) => void;
}) {
  const focusablePanes = run.workers.filter(
    (worker): worker is typeof worker & { panelId: string } =>
      Boolean(worker.panelId),
  );
  if (focusablePanes.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {focusablePanes.map((worker) => (
        <button
          key={worker.panelId}
          type="button"
          className="flex items-center gap-1 rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:border-rose-600 hover:text-rose-300"
          onClick={() => onFocusPane(worker.panelId)}
        >
          <Crosshair className="h-3 w-3" /> 聚焦 {ROLE_LABEL[worker.role]} pane
        </button>
      ))}
    </div>
  );
}
