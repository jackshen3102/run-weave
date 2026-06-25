import type {
  HumanGatePhase,
  HumanGateVerdictValue,
  OrchestratorRoundConfirmationVerdictValue,
  OrchestratorRunPackage,
  OrchestratorRunStatus,
} from "@runweave/shared";
import {
  CheckCircle,
  MessageSquare,
  Pause,
  Play,
  Plus,
  RotateCcw,
  XCircle,
} from "lucide-react";
import { Button } from "../../ui/button";
import {
  cleanSummaryText,
  DO_A_IDEM_PHASES,
  firstReadableLine,
  formatGoalTitle,
  formatTime,
  formatTimelineTitle,
  phaseLabel,
  shortId,
} from "./run-monitor-format";

export function RunMonitor(props: {
  run: OrchestratorRunPackage;
  loading: boolean;
  injectText: string;
  gateReason: string;
  onInjectTextChange: (value: string) => void;
  onGateReasonChange: (value: string) => void;
  onInject: () => void;
  onHumanGate: (phase: HumanGatePhase, verdict: HumanGateVerdictValue) => void;
  onRoundConfirmation: (
    confirmationId: string,
    verdict: OrchestratorRoundConfirmationVerdictValue,
  ) => void;
  onPause: () => void;
  onResume: () => void;
  onRestart: () => void;
  onNewBlankRun: () => void;
  onSelectSession?: (terminalSessionId: string) => void;
}) {
  const currentGatePhase =
    props.run.currentPhase === "human_plan_approval" ||
    props.run.currentPhase === "human_verify"
      ? props.run.currentPhase
      : null;
  const summaries = props.run.goals.filter((goal) => goal.result?.summary);
  return (
    <div className="space-y-4">
      {props.run.status === "need_human" ? (
        <div className="rounded-md border border-amber-700/70 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
          需要人工介入：
          {props.run.pendingRoundConfirmation
            ? "轮次确认"
            : phaseLabel(props.run.currentPhase)}
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{props.run.task}</p>
          <p className="text-[11px] text-slate-500">Run: {props.run.runId}</p>
        </div>
        <StatusBadge status={props.run.status} />
      </div>
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 text-xs font-medium text-slate-300">
            当前阶段
          </div>
          <span className="shrink-0 rounded border border-slate-700 px-2 py-1 text-[10px] uppercase text-slate-300">
            {props.run.currentPhase ?? "unknown"}
          </span>
        </div>
        <PhaseRail currentPhase={props.run.currentPhase} />
      </section>
      {currentGatePhase ? (
        <HumanGateCard
          phase={currentGatePhase}
          loading={props.loading}
          reason={props.gateReason}
          onReasonChange={props.onGateReasonChange}
          onSubmit={props.onHumanGate}
          injectText={props.injectText}
          onInject={props.onInject}
        />
      ) : null}
      {props.run.pendingRoundConfirmation ? (
        <RoundConfirmationCard
          pending={props.run.pendingRoundConfirmation}
          loading={props.loading}
          reason={props.gateReason}
          onReasonChange={props.onGateReasonChange}
          onSubmit={props.onRoundConfirmation}
        />
      ) : null}
      <section className="space-y-2">
        <div className="text-xs font-medium text-slate-300">目标进度</div>
        {props.run.goals.length ? (
          props.run.goals.map((goal) => {
            const summary = firstReadableLine(goal.result?.summary);
            const desc = firstReadableLine(goal.desc);
            const detail = summary || desc;
            return (
              <button
                type="button"
                key={goal.id}
                className={[
                  "block w-full border-t border-slate-800 py-2.5 text-left text-xs text-slate-300 transition-colors",
                  goal.sessionId
                    ? "hover:text-slate-100"
                    : "cursor-default hover:text-slate-300",
                ].join(" ")}
                onClick={() => {
                  if (goal.sessionId) {
                    props.onSelectSession?.(goal.sessionId);
                  }
                }}
              >
                <div className="flex min-w-0 items-start gap-2.5">
                  <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center text-slate-400">
                    {goalIcon(goal.status)}
                  </span>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span className="shrink-0 rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300">
                        {goalStatusLabel(goal.status)}
                      </span>
                      <span
                        className="min-w-0 flex-1 truncate font-medium text-slate-100"
                        title={goal.id}
                      >
                        {formatGoalTitle(goal.id)}
                      </span>
                    </div>
                    {detail ? (
                      <p className="line-clamp-2 whitespace-pre-wrap text-slate-400">
                        {detail}
                      </p>
                    ) : null}
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
                      {goal.assignedRole ? (
                        <span className="shrink-0">{goal.assignedRole}</span>
                      ) : null}
                      {goal.sessionId ? (
                        <span className="min-w-0 truncate">
                          terminal {shortId(goal.sessionId)}
                        </span>
                      ) : null}
                      {goal.attempts > 1 ? (
                        <span className="shrink-0">
                          attempt {goal.attempts}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>
              </button>
            );
          })
        ) : (
          <p className="text-xs text-slate-500">等待主 Agent 派发目标。</p>
        )}
      </section>
      <section className="space-y-2">
        <div className="text-xs font-medium text-slate-300">Summary</div>
        {summaries.length ? (
          summaries.map((goal) => (
            <div
              key={goal.id}
              className="border-t border-slate-800 py-2 text-xs"
            >
              <div className="flex items-center gap-2 text-slate-300">
                <span className="min-w-0 flex-1 truncate">{goal.id}</span>
                <span className="shrink-0 text-slate-500">
                  {goal.assignedRole}
                </span>
              </div>
              <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-slate-500">
                {cleanSummaryText(goal.result?.summary)}
              </p>
            </div>
          ))
        ) : (
          <p className="text-xs text-slate-500">等待 worker summary。</p>
        )}
      </section>
      {props.run.humanGateVerdicts?.length ? (
        <section className="space-y-2">
          <div className="text-xs font-medium text-slate-300">人工门禁记录</div>
          {props.run.humanGateVerdicts.map((verdict) => (
            <div
              key={verdict.id}
              className="border-t border-slate-800 py-2 text-xs"
            >
              <div className="flex items-center gap-2">
                <span className="text-slate-500">{formatTime(verdict.at)}</span>
                <span className="min-w-0 flex-1 truncate text-slate-200">
                  {phaseLabel(verdict.phase)} {verdict.verdict}
                </span>
              </div>
              {verdict.reason ? (
                <p className="mt-1 line-clamp-3 text-slate-500">
                  {verdict.reason}
                </p>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}
      {props.run.roundConfirmations?.length ? (
        <section className="space-y-2">
          <div className="text-xs font-medium text-slate-300">轮次确认记录</div>
          {props.run.roundConfirmations.map((confirmation) => (
            <div
              key={confirmation.id}
              className="border-t border-slate-800 py-2 text-xs"
            >
              <div className="flex items-center gap-2">
                <span className="text-slate-500">
                  {formatTime(confirmation.at)}
                </span>
                <span className="min-w-0 flex-1 truncate text-slate-200">
                  {phaseLabel(confirmation.fromPhase)} {"->"}{" "}
                  {phaseLabel(confirmation.nextPhase)} {confirmation.verdict}
                </span>
              </div>
              {confirmation.reason ? (
                <p className="mt-1 line-clamp-3 text-slate-500">
                  {confirmation.reason}
                </p>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}
      <section className="space-y-2">
        <div className="text-xs font-medium text-slate-300">人工介入</div>
        <textarea
          value={props.injectText}
          onChange={(event) => props.onInjectTextChange(event.target.value)}
          className="min-h-20 w-full resize-y rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100 outline-none focus:border-sky-600"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={props.loading || !props.injectText.trim()}
            onClick={props.onInject}
          >
            <MessageSquare />
            注入提示
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={props.loading || props.run.status === "paused"}
            onClick={props.onPause}
          >
            <Pause />
            暂停
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={props.loading || props.run.status === "running"}
            onClick={props.onResume}
          >
            <Play />
            继续
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={props.loading}
            onClick={props.onRestart}
          >
            <RotateCcw />
            重新开始
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={props.loading}
            onClick={props.onNewBlankRun}
          >
            <Plus />
            新建空白 Run
          </Button>
        </div>
      </section>
      <section className="space-y-2">
        <div className="text-xs font-medium text-slate-300">时间线</div>
        {props.run.timeline.map((item) => {
          const detail = cleanSummaryText(item.detail);
          return (
            <div
              key={item.id}
              className="border-t border-slate-800 py-2 text-xs"
            >
              <div className="flex items-start gap-2">
                <span className="shrink-0 text-slate-500">
                  {formatTime(item.at)}
                </span>
                <span className="min-w-0 flex-1 break-words text-slate-200">
                  {formatTimelineTitle(item.title)}
                </span>
              </div>
              {detail ? (
                <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-slate-500">
                  {detail}
                </p>
              ) : null}
            </div>
          );
        })}
      </section>
    </div>
  );
}

function PhaseRail(props: {
  currentPhase: OrchestratorRunPackage["currentPhase"];
}) {
  const currentIndex = props.currentPhase
    ? DO_A_IDEM_PHASES.indexOf(props.currentPhase)
    : -1;
  return (
    <div className="grid grid-cols-1 gap-1 text-[11px] sm:grid-cols-3">
      {DO_A_IDEM_PHASES.map((phase, index) => {
        const active = phase === props.currentPhase;
        const complete = currentIndex >= 0 && index < currentIndex;
        return (
          <div
            key={phase}
            className={[
              "min-w-0 rounded border px-2 py-1",
              active
                ? "border-sky-500 bg-sky-950/40 text-sky-100"
                : complete
                  ? "border-emerald-800/70 text-emerald-200"
                  : "border-slate-800 text-slate-500",
            ].join(" ")}
          >
            <span className="block truncate">{phaseLabel(phase)}</span>
          </div>
        );
      })}
    </div>
  );
}

function HumanGateCard(props: {
  phase: HumanGatePhase;
  loading: boolean;
  reason: string;
  injectText: string;
  onReasonChange: (value: string) => void;
  onSubmit: (phase: HumanGatePhase, verdict: HumanGateVerdictValue) => void;
  onInject: () => void;
}) {
  const isVerify = props.phase === "human_verify";
  const rejectDisabled = props.loading || !props.reason.trim();
  return (
    <section className="space-y-2 rounded-md border border-amber-800/70 bg-amber-950/20 px-3 py-3">
      <div className="text-xs font-medium text-amber-100">
        {isVerify ? "人工验收" : "计划审批"}
      </div>
      <textarea
        value={props.reason}
        onChange={(event) => props.onReasonChange(event.target.value)}
        placeholder={isVerify ? "不通过原因" : "拒绝原因"}
        className="min-h-16 w-full resize-y rounded-md border border-amber-900/70 bg-slate-950 px-3 py-2 text-xs text-slate-100 outline-none focus:border-amber-500"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={props.loading}
          onClick={() => props.onSubmit(props.phase, "approved")}
        >
          <CheckCircle />
          {isVerify ? "通过，进入提交" : "通过"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={rejectDisabled}
          onClick={() => props.onSubmit(props.phase, "rejected")}
        >
          <XCircle />
          {isVerify ? "不通过，返回修改" : "拒绝并要求修订"}
        </Button>
        {isVerify ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={props.loading || !props.injectText.trim()}
            onClick={props.onInject}
          >
            <MessageSquare />
            补充验证/提问
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function RoundConfirmationCard(props: {
  pending: NonNullable<OrchestratorRunPackage["pendingRoundConfirmation"]>;
  loading: boolean;
  reason: string;
  onReasonChange: (value: string) => void;
  onSubmit: (
    confirmationId: string,
    verdict: OrchestratorRoundConfirmationVerdictValue,
  ) => void;
}) {
  const rejectDisabled = props.loading || !props.reason.trim();
  return (
    <section className="space-y-2 rounded-md border border-amber-800/70 bg-amber-950/20 px-3 py-3">
      <div className="text-xs font-medium text-amber-100">轮次确认</div>
      <div className="space-y-1 text-xs text-slate-300">
        <div>
          {phaseLabel(props.pending.fromPhase)} {"->"}{" "}
          {phaseLabel(props.pending.nextPhase)}
        </div>
        <div className="text-slate-500">
          {props.pending.goalId ?? props.pending.roleId ?? props.pending.id}
        </div>
        <p className="line-clamp-4 whitespace-pre-wrap text-slate-400">
          {props.pending.summary}
        </p>
      </div>
      <textarea
        value={props.reason}
        onChange={(event) => props.onReasonChange(event.target.value)}
        placeholder="不通过原因"
        className="min-h-16 w-full resize-y rounded-md border border-amber-900/70 bg-slate-950 px-3 py-2 text-xs text-slate-100 outline-none focus:border-amber-500"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={props.loading}
          onClick={() => props.onSubmit(props.pending.id, "approved")}
        >
          <CheckCircle />
          通过，进入下一阶段
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={rejectDisabled}
          onClick={() => props.onSubmit(props.pending.id, "rejected")}
        >
          <XCircle />
          不通过，返回修改
        </Button>
      </div>
    </section>
  );
}

function StatusBadge({ status }: { status: OrchestratorRunStatus }) {
  return (
    <span className="rounded border border-slate-700 px-2 py-1 text-[10px] uppercase text-slate-300">
      {status}
    </span>
  );
}

function goalIcon(status: string) {
  if (status === "done") {
    return <CheckCircle className="h-4 w-4 text-emerald-300" />;
  }
  if (status === "running") {
    return <Play className="h-4 w-4 text-sky-300" />;
  }
  if (status === "blocked") {
    return <Pause className="h-4 w-4 text-amber-300" />;
  }
  if (status === "failed") {
    return <XCircle className="h-4 w-4 text-rose-300" />;
  }
  return <span className="h-2 w-2 rounded-full bg-slate-600" />;
}

function goalStatusLabel(status: string): string {
  if (status === "done") {
    return "完成";
  }
  if (status === "running") {
    return "运行中";
  }
  if (status === "blocked") {
    return "受阻";
  }
  if (status === "failed") {
    return "失败";
  }
  return "等待";
}
