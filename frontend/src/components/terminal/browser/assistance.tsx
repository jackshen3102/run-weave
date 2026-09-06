import { useEffect, useRef, useState } from "react";
import { useMemoizedFn } from "ahooks";
import type {
  BrowserAssistanceRequest,
  BrowserAssistanceState,
} from "@runweave/shared/terminal-browser-assistance";
import { useTerminalRuntime } from "../../../features/terminal/queries/provider";
import { useTerminalPreviewStore } from "../../../features/terminal/preview/store";
import {
  listBrowserAssistance,
  updateBrowserAssistance,
} from "../../../services/terminal/browser-assistance";
import { HttpError } from "../../../services/http";
import { Button } from "../../ui/button";

const LABEL: Record<BrowserAssistanceState, string> = {
  requesting: "等待 Agent 结束当前轮次，请先不要操作页面",
  waiting: "Agent 等待协助：请处理页面，完成后交还",
  resume_pending: "已发送交还，等待 Agent 确认（不会自动重发）",
  acknowledged: "Agent 已确认交还，将重新观察页面；不代表任务已完成",
  cancelled: "已取消协助，Agent 不会自动恢复",
  expired: "协助请求已过期，请让 Agent 重新观察并请求",
  invalidated: "原 Agent、Panel 已改变或终端收到新输入，请重新请求协助",
  delivery_unknown: "交还投递结果不确定，请检查原终端；不会自动重发",
};
const FINISHED = new Set<BrowserAssistanceState>([
  "acknowledged",
  "cancelled",
  "expired",
  "invalidated",
]);

export function TerminalBrowserAssistance({
  sessionId,
}: {
  sessionId: string | null;
}) {
  const { apiBase, token, onAuthExpired } = useTerminalRuntime();
  const [requests, setRequests] = useState<BrowserAssistanceRequest[]>([]);
  const [error, setError] = useState<{
    message: string;
    requestId?: string;
  } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;
  const handleError = useMemoizedFn((failure: unknown, requestId?: string) => {
    if (failure instanceof HttpError && failure.status === 401)
      onAuthExpired?.();
    setError({
      message: failure instanceof Error ? failure.message : "无法读取协助请求",
      requestId,
    });
  });

  useEffect(() => {
    setRequests([]);
    setError(null);
    if (
      !sessionId ||
      !window.electronAPI?.terminalBrowserResolveAssistanceTarget
    )
      return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await listBrowserAssistance(
          apiBase,
          token,
          sessionId,
          controller.signal,
        );
        if (!controller.signal.aborted) setRequests(next);
      } catch (failure) {
        if (!controller.signal.aborted) handleError(failure);
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => void poll(), 2000);
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [apiBase, token, sessionId, handleError]);

  const act = useMemoizedFn(
    async (
      request: BrowserAssistanceRequest,
      action: "open" | "resume" | "cancel",
    ) => {
      if (busyId || request.terminalSessionId !== currentSession.current)
        return;
      setBusyId(request.requestId);
      setError(null);
      try {
        if (action !== "cancel") {
          const bridge = window.electronAPI;
          if (
            !bridge?.terminalBrowserResolveAssistanceTarget ||
            !bridge.terminalBrowserShow
          ) {
            throw new Error("当前桌面版本不支持浏览器协助");
          }
          const tabId =
            await bridge.terminalBrowserResolveAssistanceTarget(request);
          if (request.terminalSessionId !== currentSession.current) return;
          if (action === "open") {
            await bridge.terminalBrowserShow(tabId);
            useTerminalPreviewStore
              .getState()
              .activateBrowser(request.profileId, null);
            return;
          }
        }
        const updated = await updateBrowserAssistance(
          apiBase,
          token,
          request,
          action,
        );
        if (request.terminalSessionId === currentSession.current) {
          setRequests((previous) =>
            previous.map((item) =>
              item.requestId === updated.requestId ? updated : item,
            ),
          );
        }
      } catch (failure) {
        if (request.terminalSessionId === currentSession.current)
          handleError(failure, request.requestId);
      } finally {
        setBusyId(null);
      }
    },
  );

  const latest = new Map<string, BrowserAssistanceRequest>();
  for (const request of requests) latest.set(request.panelId, request);
  const visible = [...latest.values()].filter(
    (request) => !dismissed.includes(request.requestId),
  );
  const visibleError =
    error &&
    (!error.requestId ||
      visible.some((request) => request.requestId === error.requestId))
      ? error.message
      : null;
  if (!visible.length && !visibleError) return null;
  return (
    <section
      aria-label="浏览器人工协助"
      className="max-h-64 shrink-0 overflow-auto border-b border-amber-500/30 bg-amber-500/5 p-3 text-xs"
    >
      {visible.map((request) => (
        <div
          key={request.requestId}
          className="space-y-2 py-1"
          data-assistance-id={request.requestId}
        >
          <p role="status" className="font-medium">
            {LABEL[request.state]}
          </p>
          <p className="whitespace-pre-wrap break-words">{request.reason}</p>
          <p className="text-muted-foreground">
            Panel {request.panelId.slice(0, 8)} · {request.profileId} ·{" "}
            {request.requestId.slice(0, 8)}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busyId !== null || request.state !== "waiting"}
              onClick={() => void act(request, "open")}
            >
              打开协助页面
            </Button>
            <Button
              size="sm"
              disabled={busyId !== null || request.state !== "waiting"}
              onClick={() => void act(request, "resume")}
            >
              完成并交还 Agent
            </Button>
            {["requesting", "waiting"].includes(request.state) ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busyId !== null}
                onClick={() => void act(request, "cancel")}
              >
                取消协助
              </Button>
            ) : null}
            {FINISHED.has(request.state) ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setDismissed((ids) => [...ids, request.requestId])
                }
              >
                收起
              </Button>
            ) : null}
          </div>
        </div>
      ))}
      {visibleError ? (
        <p role="alert" className="mt-2 text-rose-400">
          {visibleError}
        </p>
      ) : null}
    </section>
  );
}
