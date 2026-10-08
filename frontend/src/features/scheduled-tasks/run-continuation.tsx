import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  scheduledReplyUnavailable,
  scheduledRecoveryNotice,
} from "@runweave/shared/scheduled-tasks";
import type { ScheduledRun } from "@runweave/shared/scheduled-tasks";
import { Button } from "../../components/ui/button";
import { useRefreshTasks, useRun, useScheduledApi } from "./queries";
import { displayTime, RequestError } from "./presentation";
import { RunSummary } from "./run-summary";

export function RunContinuation({ run }: { run: ScheduledRun }) {
  const { api } = useScheduledApi();
  const refresh = useRefreshTasks();
  const [history, setHistory] = useState(false);
  const [reply, setReply] = useState("");
  const detail = useRun(history ? run.id : null);
  const request = useRef<{
    revision: number;
    key: string;
    reply?: string;
  } | null>(null);
  const resume = useMutation({
    mutationFn: (userReply?: string) => {
      const revision = run.revision ?? 0;
      if (
        request.current?.revision !== revision ||
        request.current?.reply !== userReply
      )
        request.current = {
          revision,
          key: crypto.randomUUID(),
          reply: userReply,
        };
      return api.continue(run.id, revision, request.current.key, userReply);
    },
    onSuccess: () => {
      setReply("");
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
  const unavailable = scheduledReplyUnavailable(run);
  const notice = scheduledRecoveryNotice(run);
  const confirmation = state?.recovery?.confirmation;
  const pending = resume.isPending || stop.isPending;
  if (!state && unavailable) return null;
  return (
    <div
      className="space-y-2 rounded-lg border p-3 text-sm"
      data-testid="run-continuation"
    >
      <p>
        自动重试 {state?.count ?? 0}/{state?.maxAttempts ?? 3} 次
      </p>
      {state?.nextAt ? (
        <p>等待恢复 · 下次继续：{displayTime(state?.nextAt)}</p>
      ) : null}
      {notice ? <p className="text-orange-400">{notice}</p> : null}
      {state?.recovery && !["queued", "running", "stopping"].includes(run.status) ? (
        <p className="whitespace-pre-wrap break-words">
          {state?.recovery.nextStep}
        </p>
      ) : null}
      {run.status === "waiting" && state?.nextAt ? (
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={resume.isPending || stop.isPending}
            onClick={() => resume.mutate(undefined)}
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
      {!unavailable ? (
        <div className="space-y-2">
          {confirmation ? (
            <div className="space-y-2 rounded border p-2">
              <p className="whitespace-pre-wrap">待确认：{confirmation}</p>
              <Button
                size="sm"
                disabled={pending}
                onClick={() =>
                  resume.mutate(`确认：${confirmation}。允许按上述事项继续。`)
                }
              >
                允许并继续
              </Button>
            </div>
          ) : null}
          <label className="block text-xs" htmlFor={`run-reply-${run.id}`}>
            直接回复 Agent
          </label>
          <textarea
            id={`run-reply-${run.id}`}
            className="min-h-20 w-full rounded border bg-background p-2"
            value={reply}
            maxLength={8000}
            disabled={pending}
            onChange={(event) => setReply(event.target.value)}
            placeholder="回答上方待处理事项，或补充范围、条件及说明"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={pending || !reply.trim()}
              onClick={() => resume.mutate(reply.trim())}
            >
              发送并继续
            </Button>
            {state?.recovery?.action !== "needs-input" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  resume.mutate(
                    "请重新核对当前条件，在原授权范围内继续尚未完成的任务。",
                  )
                }
              >
                重试
              </Button>
            ) : null}
          </div>
        </div>
      ) : ["failed", "cancelled"].includes(run.status) ? (
        <p className="text-xs text-muted-foreground">{unavailable}</p>
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
              {attempt.userReply ? (
                <p className="whitespace-pre-wrap text-xs">
                  你的回复：{attempt.userReply}
                </p>
              ) : null}
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
