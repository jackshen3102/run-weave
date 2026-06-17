import type {
  OrchestratorRunPackage,
  OrchestratorRunStatus,
} from "@runweave/shared";
import {
  MessageSquare,
  Pause,
  Play,
  RotateCcw,
} from "lucide-react";
import { Button } from "../ui/button";

export function RunMonitor(props: {
  run: OrchestratorRunPackage;
  loading: boolean;
  injectText: string;
  onInjectTextChange: (value: string) => void;
  onInject: () => void;
  onPause: () => void;
  onResume: () => void;
  onRestart: () => void;
  onSelectSession?: (terminalSessionId: string) => void;
}) {
  return (
    <div className="space-y-4">
      {props.run.status === "need_human" ? (
        <div className="rounded-md border border-amber-700/70 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
          需要人工介入
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
        <div className="text-xs font-medium text-slate-300">目标进度</div>
        {props.run.goals.length ? (
          props.run.goals.map((goal) => (
            <button
              type="button"
              key={goal.id}
              className="flex w-full items-center gap-2 border-t border-slate-800 py-2 text-left text-xs text-slate-300 hover:text-slate-100"
              onClick={() => {
                if (goal.sessionId) {
                  props.onSelectSession?.(goal.sessionId);
                }
              }}
            >
              <span className="w-5 shrink-0">{goalIcon(goal.status)}</span>
              <span className="min-w-0 flex-1 truncate">{goal.id} {goal.desc}</span>
              <span className="shrink-0 text-slate-500">{goal.assignedRole}</span>
            </button>
          ))
        ) : (
          <p className="text-xs text-slate-500">等待主 Agent 派发目标。</p>
        )}
      </section>
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
        </div>
      </section>
      <section className="space-y-2">
        <div className="text-xs font-medium text-slate-300">时间线</div>
        {props.run.timeline.map((item) => (
          <div key={item.id} className="border-t border-slate-800 py-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-slate-500">{formatTime(item.at)}</span>
              <span className="min-w-0 flex-1 truncate text-slate-200">
                {item.title}
              </span>
            </div>
            {item.detail ? (
              <p className="mt-1 line-clamp-3 text-slate-500">{item.detail}</p>
            ) : null}
          </div>
        ))}
      </section>
    </div>
  );
}

function StatusBadge({ status }: { status: OrchestratorRunStatus }) {
  return (
    <span className="rounded border border-slate-700 px-2 py-1 text-[10px] uppercase text-slate-300">
      {status}
    </span>
  );
}

function goalIcon(status: string): string {
  if (status === "done") {
    return "OK";
  }
  if (status === "running") {
    return ">";
  }
  if (status === "blocked") {
    return "II";
  }
  if (status === "failed") {
    return "X";
  }
  return ".";
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

