import { AlertTriangle, Crosshair, Play, Plus, X } from "lucide-react";
import type { AgentTeamRun } from "@runweave/shared";
import { Button } from "../ui/button";
import {
  ROLE_CYCLE,
  ROLE_LABEL,
  type WorkerDraft,
} from "./terminal-agent-team-panel-model";

export function StartFlowSection({
  task,
  autoApproveSplit,
  busy,
  onTaskChange,
  onToggleAutoApprove,
  onStart,
}: {
  task: string;
  autoApproveSplit: boolean;
  busy: boolean;
  onTaskChange: (value: string) => void;
  onToggleAutoApprove: () => void;
  onStart: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="text-sm font-medium text-slate-200">这是一个普通终端</div>
      <p className="text-xs leading-relaxed text-slate-400">
        当前是标准 shell 会话，没有多 Agent 流程。想让主 Agent 接管、驱动
        <code className="mx-1 rounded bg-slate-800 px-1">
          需求澄清 → 拆分提案 → 执行观测
        </code>
        的 engineering-rules 流程，点下面开启。
      </p>
      <ol className="space-y-1 pl-4 text-xs text-slate-400 [list-style:decimal]">
        <li>主 Agent 在本终端里跑，与你澄清意图</li>
        <li>澄清充分后产出 worker 拆分提案，你确认</li>
        <li>确认后 split 出 worker pane，右侧退回只读观测</li>
      </ol>
      <textarea
        className="min-h-20 w-full resize-y rounded border border-slate-800 bg-slate-950 px-2 py-1.5 text-xs text-slate-100 outline-none placeholder:text-slate-500 focus:border-sky-600"
        value={task}
        onChange={(event) => onTaskChange(event.target.value)}
        placeholder="输入这次 Agent Team 要执行的任务"
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
        <Play className="h-4 w-4" /> 在此终端开启 engineering-rules 流程
      </Button>
    </div>
  );
}

export function ClarifySection({
  run,
  busy,
  onRequestSplit,
}: {
  run: AgentTeamRun;
  busy: boolean;
  onRequestSplit: (source: "user" | "agent") => void;
}) {
  const auto = run.options.autoApproveSplit;
  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold uppercase text-slate-400">
        需求澄清
      </h3>
      <div className="space-y-2">
        {run.clarify.map((message, index) => (
          <div
            key={`${message.at}-${index}`}
            className={[
              "rounded px-2 py-1.5 text-xs",
              message.from === "agent"
                ? "bg-slate-800/70 text-slate-200"
                : "bg-sky-950/50 text-sky-200",
            ].join(" ")}
          >
            {message.text}
          </div>
        ))}
      </div>
      <Button
        type="button"
        size="sm"
        className="w-full"
        disabled={busy}
        onClick={() => onRequestSplit("user")}
      >
        {auto ? "澄清完成 · 自动拆分并执行 →" : "澄清完成 · 让主 Agent 拆分 →"}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="w-full"
        disabled={busy}
        onClick={() => onRequestSplit("agent")}
      >
        模拟主 Agent 判断澄清充分（Agent 主导）
      </Button>
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
            主 Agent 把澄清目标落成可观测验收用例，由 behavior_verify worker
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
  onFocusPane,
}: {
  run: AgentTeamRun;
  busy: boolean;
  resumeNote: string;
  onResumeNoteChange: (value: string) => void;
  onRecordRound: (hadProgress: boolean) => void;
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
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase text-slate-400">
          Loop 状态
        </h3>
        <span className="rounded border border-slate-700 px-1.5 py-0.5 text-[9px] uppercase text-slate-500">
          Observe Only
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
            placeholder="填写人工干预 note（恢复时注入主 Agent，并重置错误指纹）"
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
            人工已介入 · 恢复 loop →
          </Button>
        </div>
      ) : (
        <div className="rounded border border-slate-800 bg-slate-900/40 p-2">
          <div className="mb-1 text-[10px] text-slate-500">
            模拟 loop 反馈（连续 {loop.maxNoProgress} 轮无进展将自动熔断）：
          </div>
          <div className="flex gap-2">
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
        </div>
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
                  {item.evidence.length > 0 ? (
                    <div className="mt-0.5 text-[10px] text-slate-500">
                      {item.evidence
                        .map((ev) => `${ev.type}:${ev.ref}`)
                        .join(" · ")}
                    </div>
                  ) : null}
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
