import { GitCompare, Plus } from "lucide-react";
import type { RaceRecord, RaceWorkerRecord } from "@runweave/shared/race";
import type { TerminalSessionListItem } from "@runweave/shared/terminal/session";
import type { TerminalState } from "@runweave/shared/terminal/state";

interface WorkerPresentation {
  label: string;
  dotClass: string;
}

interface TerminalRaceObserverProps {
  race: RaceRecord;
  sessionsById: Map<string, TerminalSessionListItem>;
  terminalStateBySessionId: Record<string, TerminalState>;
  changedWorkerIds: Set<string>;
  error: string | null;
  ending: boolean;
  onFocusWorker: (worker: RaceWorkerRecord) => void;
  onOpenWorkerDiff: (worker: RaceWorkerRecord) => void;
  onEndRace: () => void;
}

function statusPresentation(
  worker: RaceWorkerRecord,
  session: TerminalSessionListItem | undefined,
  terminalState: TerminalState | undefined,
): WorkerPresentation {
  if (worker.launchStatus === "failed") {
    return {
      label: "失败",
      dotClass: "bg-rose-500",
    };
  }
  if (
    worker.launchStatus === "starting" ||
    terminalState?.state === "agent_starting"
  ) {
    return {
      label: "启动中",
      dotClass: "bg-amber-400 animate-pulse",
    };
  }
  if (terminalState?.state === "agent_running") {
    return {
      label: "运行中",
      dotClass: "bg-cyan-400 animate-pulse",
    };
  }
  if (!session) {
    return {
      label: "启动中",
      dotClass: "bg-amber-400 animate-pulse",
    };
  }
  return {
    label: "空闲 · 待查看",
    dotClass: "bg-sky-500",
  };
}

export function TerminalRaceObserver({
  race,
  sessionsById,
  terminalStateBySessionId,
  changedWorkerIds,
  error,
  ending,
  onFocusWorker,
  onOpenWorkerDiff,
  onEndRace,
}: TerminalRaceObserverProps) {
  const idleCount = race.workers.filter((worker) => {
    const session = worker.terminalSessionId
      ? sessionsById.get(worker.terminalSessionId)
      : undefined;
    const terminalState = worker.terminalSessionId
      ? (terminalStateBySessionId[worker.terminalSessionId] ??
        session?.terminalState)
      : undefined;
    return (
      statusPresentation(worker, session, terminalState).label ===
      "空闲 · 待查看"
    );
  }).length;

  return (
    <div
      className="flex h-full min-h-0 flex-col text-slate-200"
      data-testid="terminal-race-observer"
    >
      <div className="border-b border-slate-800 px-3 py-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-slate-300">Race</span>
          <span className="rounded bg-cyan-500/15 px-1.5 py-0.5 text-[10px] uppercase text-cyan-300">
            active
          </span>
        </div>
        <p className="mt-0.5 truncate font-mono text-[10px] text-slate-500">
          {race.workers.length} workers · {race.baseRef}
        </p>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {idleCount > 0 ? (
          <p className="rounded border border-slate-700 bg-slate-900/60 px-2 py-1.5 text-[11px] text-slate-400">
            {idleCount} 个 Worker 已空闲；进入各自 Terminal
            确认是完成还是在等待输入。
          </p>
        ) : null}
        <section>
          <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            目标
          </h3>
          <p className="rounded border border-slate-800 bg-slate-900/60 px-2 py-1.5 text-[11px] leading-relaxed text-slate-300">
            {race.goal}
          </p>
        </section>
        <section>
          <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Workers
          </h3>
          <div className="space-y-1.5">
            {race.workers.map((worker) => {
              const session = worker.terminalSessionId
                ? sessionsById.get(worker.terminalSessionId)
                : undefined;
              const terminalState = worker.terminalSessionId
                ? (terminalStateBySessionId[worker.terminalSessionId] ??
                  session?.terminalState)
                : undefined;
              const presentation = statusPresentation(
                worker,
                session,
                terminalState,
              );
              const hasChanges = changedWorkerIds.has(worker.workerId);
              return (
                <div
                  className="rounded border border-slate-800 bg-slate-900/60 p-2"
                  key={worker.workerId}
                >
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 text-left"
                    disabled={!worker.worktreeId}
                    onClick={() => onFocusWorker(worker)}
                  >
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${presentation.dotClass}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11px] font-semibold text-slate-200">
                        {worker.label}
                      </span>
                      <span className="block truncate font-mono text-[9px] text-slate-500">
                        <span className="text-sky-400">{worker.agent}</span>
                        {" · "}
                        {worker.model || "default"}
                      </span>
                    </span>
                    <span
                      className={[
                        "shrink-0 text-[9px] uppercase",
                        worker.launchStatus === "failed"
                          ? "text-rose-300"
                          : presentation.label === "运行中"
                            ? "text-cyan-300"
                            : presentation.label === "启动中"
                              ? "text-amber-300"
                              : "text-sky-300",
                      ].join(" ")}
                    >
                      {presentation.label}
                    </span>
                  </button>
                  {worker.launchError ? (
                    <p className="mt-1 break-words text-[10px] text-rose-300">
                      {worker.launchError}
                    </p>
                  ) : null}
                  {hasChanges && worker.worktreeId ? (
                    <button
                      type="button"
                      className="mt-1.5 inline-flex h-6 items-center gap-1 rounded border border-slate-700 px-1.5 text-[10px] text-slate-300 hover:bg-slate-800"
                      onClick={() => onOpenWorkerDiff(worker)}
                    >
                      <GitCompare className="h-3 w-3" />
                      Diff
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
        <section>
          <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Loop 日志
          </h3>
          <div className="rounded border border-slate-800 bg-slate-900/40 p-2 font-mono text-[10px] leading-relaxed text-slate-400">
            <p>· 已向 {race.workers.length} 个 Worker 下发同一目标</p>
            <p>· {changedWorkerIds.size} 个 Worker 有未提交 Git 改动</p>
            <p>· 状态仅投影 starting / running / idle / failed</p>
          </div>
        </section>
        {error ? (
          <p className="rounded border border-rose-900/70 bg-rose-950/30 px-2 py-1.5 text-[11px] text-rose-300">
            {error}
          </p>
        ) : null}
        <button
          type="button"
          className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-slate-700 text-[11px] text-slate-300 hover:bg-slate-900 disabled:opacity-50"
          disabled={ending}
          onClick={onEndRace}
        >
          <Plus className="h-3.5 w-3.5" />
          {ending ? "正在结束…" : "新的 Race 目标 / 结束 Race"}
        </button>
      </div>
    </div>
  );
}
