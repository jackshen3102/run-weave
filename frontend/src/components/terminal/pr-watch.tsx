import { useState } from "react";
import { useMemoizedFn } from "ahooks";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ChangePrWatchRequest,
  PrWatchResponse,
  StartPrWatchRequest,
} from "@runweave/shared/pr-watch";
import { useTerminalRuntime } from "../../features/terminal/queries/provider";
import { requestJson, requestVoid } from "../../services/http";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "../ui/sheet";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const status = {
  watching: "值守中",
  paused: "已暂停",
  settled: "已结束",
  error: "请检查投递",
};
export function TerminalPrWatch({ sessionId }: { sessionId: string }) {
  const { apiBase, token, scope } = useTerminalRuntime();
  const client = useQueryClient();
  const key = ["pr-watch", scope, sessionId];
  const path = `/api/terminal/session/${encodeURIComponent(sessionId)}/pr-watch`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const [open, setOpen] = useState(false);
  const [ref, setRef] = useState("");
  const state = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      requestJson<PrWatchResponse>(apiBase, path, { headers, signal }),
    refetchInterval: open ? 5000 : 15000,
    retry: false,
  });
  const watch = state.data?.watch;
  const detection = useQuery({
    queryKey: [...key, "candidate"],
    queryFn: ({ signal }) =>
      requestJson<PrWatchResponse>(apiBase, path + "?detect=true", {
        headers,
        signal,
      }),
    enabled: open && state.isSuccess && !watch,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const candidate = detection.data?.candidatePr;
  const edit = useMutation({
    mutationFn: async ({
      method,
      body,
    }: {
      method: string;
      body?: StartPrWatchRequest | ChangePrWatchRequest;
    }) => {
      if (method === "DELETE")
        return requestVoid(apiBase, path, { method, headers });
      return requestJson<PrWatchResponse>(apiBase, path, {
        method,
        headers,
        body: JSON.stringify(body),
      });
    },
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  });
  const change = useMemoizedFn((action: ChangePrWatchRequest["action"]) => {
    if (watch)
      edit.mutate({
        method: "PATCH",
        body: {
          action,
          expectedRevision: watch.revision,
          expectedInputVersion: state.data?.inputVersion,
        },
      });
  });
  const enable = useMemoizedFn(() => {
    const selection = ref.trim();
    edit.mutate({
      method: "POST",
      body: {
        operationId: crypto.randomUUID(),
        ...(selection.startsWith("https://")
          ? { prUrl: selection }
          : selection
            ? { prNumber: Number(selection) }
            : { prUrl: candidate?.prUrl }),
      },
    });
  });
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger className="border-b border-slate-800 px-3 py-1 text-left text-xs">
        PR 值守{watch && ` · #${watch.prNumber} · ${status[watch.status]}`}
      </SheetTrigger>
      <SheetContent className="w-full max-w-md" aria-describedby={undefined}>
        <SheetTitle>PR 值守</SheetTitle>
        {watch ? (
          <>
            <p>
              {watch.repoNameWithOwner} #{watch.prNumber} · {watch.prTitle}
            </p>
            <p>
              {status[watch.status]} · 纯评论唤醒 {watch.commentWakeCount}/10 ·
              连续读取失败 {watch.consecutiveReadFailures}/8
            </p>
            {watch.lastSummary && <p>{watch.lastSummary}</p>}
            {watch.status === "watching" && (
              <Button disabled={edit.isPending} onClick={() => change("pause")}>
                暂停值守
              </Button>
            )}
            {((watch.status === "paused" &&
              watch.pauseReason !== "thread_changed") ||
              watch.status === "error") && (
              <Button
                disabled={edit.isPending}
                onClick={() =>
                  change(
                    watch.pauseReason === "draft_unconfirmed"
                      ? "confirm_empty_draft_and_deliver"
                      : "resume",
                  )
                }
              >
                {watch.pauseReason === "draft_unconfirmed"
                  ? "确认输入框为空并发送"
                  : watch.status === "error"
                    ? "已核实面板，恢复值守"
                    : "恢复值守"}
              </Button>
            )}
            <Button
              disabled={edit.isPending}
              onClick={() => edit.mutate({ method: "DELETE" })}
            >
              关闭值守
            </Button>
          </>
        ) : (
          <>
            {candidate && (
              <p>
                当前分支 · #{candidate.prNumber} {candidate.prTitle}
              </p>
            )}
            <label>
              同仓库 PR 编号或 URL
              <Input
                value={ref}
                onChange={(e) => setRef(e.target.value)}
                placeholder={candidate ? String(candidate.prNumber) : "42"}
              />
            </label>
            <Button
              disabled={edit.isPending || (!ref.trim() && !candidate)}
              onClick={enable}
            >
              开启值守
            </Button>
          </>
        )}
        {(edit.error || state.error || (!watch && detection.error)) && (
          <p role="alert">
            {(edit.error ?? state.error ?? detection.error)?.message}
          </p>
        )}
      </SheetContent>
    </Sheet>
  );
}
