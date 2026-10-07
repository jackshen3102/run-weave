import { useEffect, useRef, useState } from "react";
import { useMemoizedFn } from "ahooks";
import type {
  StartSupervisionRequest,
  TaskOutcome,
} from "@runweave/shared/task-supervision";
import { useTerminalRuntime } from "../../../features/terminal/queries/provider";
import {
  startTaskSupervision,
  changeTaskSupervision,
  getTaskWatch,
} from "../../../services/task-supervision";
import { HttpError } from "../../../services/http";
import { Button } from "../../ui/button";
import { SupervisionDecisionDetails } from "./decision-details";
import { useTaskSupervisionQuery } from "../../../features/terminal/queries/task-supervision";
import { taskSupervisionStatus } from "./status";
const labels: Record<TaskOutcome, string> = {
  completed: "任务已完成",
  blocked: "需要你处理",
  continue: "任务可以继续",
};
export function TerminalTaskSupervisionPanel({
  sessionId,
}: {
  sessionId: string | null;
}) {
  const { scope, token } = useTerminalRuntime();
  if (!sessionId)
    return (
      <p className="p-4 text-xs text-slate-400">
        选择一个终端以开启长任务监控。
      </p>
    );
  return (
    <SupervisionContent
      key={`${scope}:${token}:${sessionId}`}
      sessionId={sessionId}
    />
  );
}
function SupervisionContent({ sessionId }: { sessionId: string }) {
  const { apiBase, token, onAuthExpired } = useTerminalRuntime();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);
  const submitting = useRef(false);
  const query = useTaskSupervisionQuery(sessionId);
  const discovery = query.data;
  const watch = discovery?.watch;
  const decision = watch?.decisions.at(-1);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setNotice(null);
  }, [discovery?.target?.threadId, discovery?.target?.executorGeneration]);
  const fail = useMemoizedFn((error: unknown) => {
    if (!mounted.current) return;
    if (error instanceof HttpError && error.status === 401) onAuthExpired?.();
    setNotice(error instanceof Error ? error.message : "操作失败。");
  });
  const start = useMemoizedFn(async (request: StartSupervisionRequest) => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setNotice(null);
    try {
      await startTaskSupervision(apiBase, token, request);
      if (mounted.current) {
        await query.refetch();
      }
    } catch (error) {
      fail(error);
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  });
  const change = useMemoizedFn(async (action: "pause" | "resume") => {
    if (!watch || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setNotice(null);
    try {
      try {
        await changeTaskSupervision(apiBase, token, watch.watchId, {
          action,
          expectedRevision: watch.revision,
        });
      } catch (error) {
        if (
          action !== "pause" ||
          !(error instanceof HttpError) ||
          error.status !== 409
        )
          throw error;
        const latest = await getTaskWatch(apiBase, token, watch.watchId);
        await changeTaskSupervision(apiBase, token, watch.watchId, {
          action,
          expectedRevision: latest.revision,
        });
      }
      if (mounted.current) await query.refetch();
    } catch (error) {
      fail(error);
      if (mounted.current) void query.refetch();
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  });
  return (
    <section
      aria-label="长任务监控"
      data-testid="terminal-task-supervision"
      className="flex h-full min-h-0 flex-col text-slate-200"
    >
      <header className="border-b border-slate-800 p-4">
        <h2 className="text-sm font-semibold">长任务监控</h2>
        <p className="mt-1 text-[11px] text-slate-400">
          监听此终端的 Agent 事件 · 处理最终回复
        </p>
      </header>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        {(notice || query.error || watch?.error) && (
          <p role="status" className="break-words text-xs text-amber-300">
            {notice ?? query.error?.message ?? watch?.error}
          </p>
        )}
        {!watch && (
          <p className="text-xs leading-6 text-slate-400">
            {query.isPending
              ? "正在读取当前任务…"
              : "开启后持续监听此终端的 Agent 最终回复，切换会话无需重新开启。"}
          </p>
        )}
        {!discovery?.capability.supported && (
          <p className="text-xs leading-6 text-amber-300">
            {discovery?.capability.reason}
          </p>
        )}
        {watch && (
          <>
            <p
              className={`text-sm font-medium ${watch.pauseReason === "continuation_limit" || watch.status === "error" ? "text-amber-300" : "text-sky-300"}`}
            >
              {taskSupervisionStatus(watch)}
            </p>
            <div>
              <h3 className="mb-2 text-[11px] text-slate-400">当前目标</h3>
              <p className="whitespace-pre-wrap break-words text-sm leading-6">
                {watch.goal}
              </p>
            </div>
            <div className="rounded border border-slate-800 bg-slate-900 p-3">
              <p className="text-xs">
                已使用续接额度 <strong>{watch.continuationCount}/3</strong>
              </p>
              <div className="mt-3 flex gap-2">
                {[1, 2, 3].map((n) => (
                  <span
                    key={n}
                    className={`h-1.5 flex-1 rounded ${n <= watch.continuationCount ? "bg-sky-500" : "bg-slate-700"}`}
                  />
                ))}
              </div>
              <p className="mt-2 text-[11px] text-slate-500">
                当前任务最多续接三次；新会话或新的用户输入开始新一轮。
              </p>
              {watch.decisions.some((d) =>
                ["offered", "unknown"].includes(d.delivery),
              ) && (
                <p className="mt-2 text-[11px] text-amber-300">
                  有一条续接尚未确认接收，已保留额度，不会重复发送。
                </p>
              )}
            </div>
            {decision && (
              <div className="space-y-3">
                <h3 className="text-[11px] text-slate-400">
                  {watch.status === "error" || watch.status === "classifying"
                    ? "上次判断（当前轮尚无有效结果）"
                    : "最新判断"}
                </h3>
                <p className="text-sm">{labels[decision.outcome]}</p>
                <p className="text-xs leading-6 text-slate-400">
                  {decision.reason}
                </p>
                <p className="text-[11px] text-slate-500">
                  选项评分 · Codex 相对评分
                </p>
                {(["completed", "blocked", "continue"] as const).map(
                  (option) => (
                    <div
                      key={option}
                      className={`flex justify-between rounded p-2 text-xs ${option === decision.outcome ? "bg-sky-950 text-sky-300" : "text-slate-500"}`}
                    >
                      <span>{labels[option]}</span>
                      <span>{(decision.scores[option] * 100).toFixed(1)}</span>
                    </div>
                  ),
                )}
                <SupervisionDecisionDetails decision={decision} />
              </div>
            )}
            <details className="text-[11px] leading-6 text-slate-500">
              <summary>监听身份与活动</summary>
              <p className="break-all">
                watch {watch.watchId}
                <br />
                thread {watch.target.threadId}
                <br />
                更新于 {new Date(watch.updatedAt).toLocaleString()}
              </p>
              {watch.decisions.map((d) => (
                <p key={d.decisionId}>
                  {new Date(d.createdAt).toLocaleTimeString()} ·{" "}
                  {labels[d.outcome]} · {d.delivery}
                </p>
              ))}
            </details>
          </>
        )}
      </div>
      <footer className="flex items-center justify-between gap-3 border-t border-slate-800 p-4">
        <span className="text-xs text-slate-400">
          终端监控 · 切换会话后保持开启
        </span>
        <Button
          size="sm"
          role="switch"
          aria-label="终端任务监控"
          aria-checked={watch?.enabled ?? false}
          disabled={
            busy || (!watch?.enabled && !discovery?.capability.supported)
          }
          onClick={() => {
            if (watch) void change(watch.enabled ? "pause" : "resume");
            else if (discovery?.target)
              void start({
                target: discovery.target,
                taskStartMessageId: "",
                goal: "",
                planPaths: [],
                requestId: crypto.randomUUID(),
              });
          }}
        >
          {busy ? "处理中…" : watch?.enabled ? "已开启" : "开启监控"}
        </Button>
      </footer>
    </section>
  );
}
