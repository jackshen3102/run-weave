import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { ScheduledRun } from "@runweave/shared/scheduled-tasks";
import { Button } from "../../components/ui/button";
import { useRefreshTasks, useRun, useScheduledApi } from "./queries";
import { displayTime, RequestError } from "./presentation";
import { RunSummary } from "./run-summary";

export function RunContinuation({ run }: { run: ScheduledRun }) {
  const { api } = useScheduledApi();
  const refresh = useRefreshTasks();
  const [history, setHistory] = useState(false);
  const detail = useRun(history ? run.id : null);
  const request = useRef<{ revision: number; key: string } | null>(null);
  const resume = useMutation({
    mutationFn: () => {
      const revision = run.revision ?? 0;
      if (request.current?.revision !== revision)
        request.current = { revision, key: crypto.randomUUID() };
      return api.continue(run.id, revision, request.current.key);
    },
    onSettled: () => {
      void refresh();
    },
  });
  const stop = useMutation({
    mutationFn: () => api.stop(run.id),
    onSettled: () => {
      void refresh();
    },
  });
  const state = run.continuation;
  if (!state) return null;
  return (
    <div
      className="space-y-2 rounded-lg border p-3 text-sm"
      data-testid="run-continuation"
    >
      <p>
        自动继续 {state.count}/{state.maxAttempts} 次
      </p>
      {state.nextAt ? (
        <p>等待恢复 · 下次继续：{displayTime(state.nextAt)}</p>
      ) : null}
      {state.stopReason ? (
        <p className="text-orange-400">{state.stopReason}</p>
      ) : null}
      {state.recovery ? (
        <p className="whitespace-pre-wrap break-words">
          {state.recovery.nextStep}
        </p>
      ) : null}
      {run.status === "waiting" && state.nextAt ? (
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={resume.isPending || stop.isPending}
            onClick={() => resume.mutate()}
          >
            立即继续
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={resume.isPending || stop.isPending}
            onClick={() => stop.mutate()}
          >
            停止自动继续
          </Button>
        </div>
      ) : null}
      <RequestError error={resume.error ?? stop.error} />
      <button
        type="button"
        className="text-xs underline"
        onClick={() => setHistory((value) => !value)}
      >
        {history ? "收起" : "查看"}每轮进展
      </button>
      {history ? (
        <div className="space-y-3">
          <RequestError error={detail.error} />
          {detail.data?.attempts?.map((attempt) => (
            <div key={attempt.id} className="border-t pt-2">
              <p>
                第 {attempt.sequence} 轮 · {displayTime(attempt.startedAt)} ·{" "}
                {attempt.finishedAt ? "已结束" : "执行中"}
              </p>
              {attempt.summary ? <RunSummary text={attempt.summary} /> : null}
              {attempt.error ? (
                <p className="break-words text-orange-400">
                  {attempt.error.message}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
