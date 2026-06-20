import { useMemoizedFn } from "ahooks";
import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import type {
  DiagnosticLogResult,
  DiagnosticLogStatus,
} from "@runweave/shared";
import {
  aiDiagnosticLog,
  frontendDiagnosticLogRecorder,
  formatDiagnosticLogResult,
} from "../features/diagnostic-logs/recorder";
import {
  downloadDiagnosticLogs,
  getDiagnosticLogResult,
  getDiagnosticLogStatus,
  startDiagnosticLogs,
  stopDiagnosticLogs,
} from "../services/diagnostic-logs";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

interface DiagnosticLogEntryProps {
  apiBase: string;
  token: string;
  variant?: "floating" | "dialog";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

interface FloatingPosition {
  x: number;
  y: number;
}

type BusyAction = "start" | "stop" | "refresh" | "download" | null;

const ENTRY_POSITION_KEY = "diagnostic-log-entry-position";

function loadPosition(): FloatingPosition | null {
  const raw = window.localStorage.getItem(ENTRY_POSITION_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<FloatingPosition>;
    if (typeof parsed.x !== "number" || typeof parsed.y !== "number") {
      return null;
    }
    return {
      x: parsed.x,
      y: parsed.y,
    };
  } catch {
    return null;
  }
}

function savePosition(position: FloatingPosition): void {
  window.localStorage.setItem(ENTRY_POSITION_KEY, JSON.stringify(position));
}

function statusLabel(status: DiagnosticLogStatus): string {
  switch (status) {
    case "recording":
      return "记录中";
    case "ended":
      return "已结束";
    case "ready":
      return "可记录";
  }
}

function statusDescription(status: DiagnosticLogStatus): string {
  switch (status) {
    case "recording":
      return "正在记录本轮复现窗口内的 AI 诊断日志。";
    case "ended":
      return "再次开始会清空上一轮结果和临时文件。";
    case "ready":
      return "只收集 AI 诊断日志工具函数写入的内容。";
  }
}

function serverPathFromResult(result: DiagnosticLogResult | null): string | null {
  return result?.files?.logsJsonl ?? result?.files?.dir ?? null;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp);
}

function downloadBlob(blob: Blob): void {
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "diagnostic-logs.jsonl";
  document.body.append(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}

function formatActionError(action: string, error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (
    message.includes("Failed to fetch") ||
    message.includes("NetworkError") ||
    message.includes("Load failed")
  ) {
    return `${action}失败：后端不可用`;
  }

  return message ? `${action}失败：${message}` : `${action}失败`;
}

export function DiagnosticLogEntry({
  apiBase,
  token,
  variant = "floating",
  open,
  onOpenChange,
}: DiagnosticLogEntryProps) {
  const isDialogVariant = variant === "dialog";
  const [status, setStatus] = useState<DiagnosticLogStatus>(
    frontendDiagnosticLogRecorder.getStatus(),
  );
  const [result, setResult] = useState<DiagnosticLogResult | null>(
    frontendDiagnosticLogRecorder.getResult(),
  );
  const [internalDialogOpen, setInternalDialogOpen] = useState(false);
  const [recordingStartedAt, setRecordingStartedAt] = useState<Date | null>(
    null,
  );
  const [message, setMessage] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [copied, setCopied] = useState(false);
  const [position, setPosition] = useState<FloatingPosition | null>(() =>
    loadPosition(),
  );
  const dragRef = useRef<{
    pointerId: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  const positionRef = useRef<FloatingPosition | null>(position);

  const resultText = useMemo(() => formatDiagnosticLogResult(result), [result]);
  const serverPath = useMemo(() => serverPathFromResult(result), [result]);
  const dialogOpen = isDialogVariant ? Boolean(open) : internalDialogOpen;
  const isBusy = busyAction !== null;

  const setDialogOpen = useMemoizedFn((nextOpen: boolean) => {
    if (isDialogVariant) {
      onOpenChange?.(nextOpen);
      return;
    }
    setInternalDialogOpen(nextOpen);
  });

  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  useEffect(() => {
    if (copied) {
      const timer = window.setTimeout(() => setCopied(false), 1600);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [copied]);

  const syncFromRecorder = useMemoizedFn(() => {
    setStatus(frontendDiagnosticLogRecorder.getStatus());
    setResult(frontendDiagnosticLogRecorder.getResult());
  });

  const loadState = useMemoizedFn(async (): Promise<void> => {
    setBusyAction("refresh");
    setMessage(null);
    try {
      const [statusResponse, latestResult] = await Promise.all([
        getDiagnosticLogStatus(apiBase, token),
        getDiagnosticLogResult(apiBase, token),
      ]);

      if (statusResponse.status === "recording") {
        if (!frontendDiagnosticLogRecorder.isRecording()) {
          frontendDiagnosticLogRecorder.start();
        }
        setStatus("recording");
        setResult(null);
        setRecordingStartedAt(parseDate(statusResponse.startedAt));
        return;
      }

      setRecordingStartedAt(null);
      frontendDiagnosticLogRecorder.setResult(latestResult);
      syncFromRecorder();
    } catch (error) {
      setMessage(formatActionError("加载诊断日志", error));
    } finally {
      setBusyAction(null);
    }
  });

  useEffect(() => {
    if (isDialogVariant && !dialogOpen) {
      return;
    }
    void loadState();
  }, [dialogOpen, isDialogVariant, loadState]);

  const handleStart = useMemoizedFn(async () => {
    setBusyAction("start");
    setMessage(null);
    setCopied(false);
    try {
      const response = await startDiagnosticLogs(apiBase, token);
      frontendDiagnosticLogRecorder.start();
      aiDiagnosticLog("diagnostic recording started", {
        trigger: isDialogVariant ? "terminal_more_menu" : "ui",
      });
      setStatus(response.status);
      setResult(null);
      setRecordingStartedAt(parseDate(response.startedAt) ?? new Date());
      if (!isDialogVariant) {
        setDialogOpen(false);
      }
    } catch (error) {
      setMessage(formatActionError("开始记录", error));
    } finally {
      setBusyAction(null);
    }
  });

  const handleStop = useMemoizedFn(async () => {
    setBusyAction("stop");
    setMessage(null);
    setCopied(false);
    try {
      aiDiagnosticLog("diagnostic recording stopping", {
        trigger: isDialogVariant ? "terminal_more_menu" : "ui",
      });
      const stoppedResult = await stopDiagnosticLogs(
        apiBase,
        token,
        frontendDiagnosticLogRecorder.getBufferedLogs(),
      );
      frontendDiagnosticLogRecorder.finish(stoppedResult);
      setRecordingStartedAt(null);
      syncFromRecorder();
      setDialogOpen(true);
      setMessage(serverPathFromResult(stoppedResult) ? "已结束记录并上报。" : null);
    } catch (error) {
      setMessage(formatActionError("结束并上报", error));
    } finally {
      setBusyAction(null);
    }
  });

  const handleView = useMemoizedFn(async () => {
    setBusyAction("refresh");
    setMessage(null);
    try {
      const latestResult = await getDiagnosticLogResult(apiBase, token);
      frontendDiagnosticLogRecorder.setResult(latestResult);
      setRecordingStartedAt(null);
      syncFromRecorder();
      setDialogOpen(Boolean(latestResult));
      if (!latestResult) {
        setMessage("暂无可查看的诊断日志结果。");
      }
    } catch (error) {
      setMessage(formatActionError("查看结果", error));
    } finally {
      setBusyAction(null);
    }
  });

  const handleDownload = useMemoizedFn(async () => {
    setBusyAction("download");
    setMessage(null);
    try {
      const blob = await downloadDiagnosticLogs(apiBase, token);
      downloadBlob(blob);
    } catch (error) {
      setMessage(formatActionError("下载日志", error));
    } finally {
      setBusyAction(null);
    }
  });

  const handleRestart = useMemoizedFn(async () => {
    setBusyAction("start");
    setMessage(null);
    setCopied(false);
    try {
      const response = await startDiagnosticLogs(apiBase, token);
      frontendDiagnosticLogRecorder.start();
      aiDiagnosticLog("diagnostic recording restarted", {
        trigger: isDialogVariant ? "terminal_more_menu" : "ui",
      });
      setStatus(response.status);
      setResult(null);
      setRecordingStartedAt(parseDate(response.startedAt) ?? new Date());
      if (!isDialogVariant) {
        setDialogOpen(false);
      }
    } catch (error) {
      setMessage(formatActionError("重新开始", error));
    } finally {
      setBusyAction(null);
    }
  });

  const handleCopyResult = useMemoizedFn(async () => {
    await navigator.clipboard?.writeText(resultText);
    setCopied(true);
  });

  const handleCopyServerPath = useMemoizedFn(async () => {
    if (!serverPath) {
      return;
    }
    await navigator.clipboard.writeText(serverPath);
    setCopied(true);
  });

  const handleDragStart = (event: React.PointerEvent<HTMLDivElement>): void => {
    const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!bounds) {
      return;
    }

    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - bounds.left,
      offsetY: event.clientY - bounds.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleDragMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    const nextPosition = {
      x: Math.min(
        Math.max(event.clientX - drag.offsetX, 8),
        window.innerWidth - 288,
      ),
      y: Math.min(
        Math.max(event.clientY - drag.offsetY, 8),
        window.innerHeight - 120,
      ),
    };
    setPosition(nextPosition);
    positionRef.current = nextPosition;
  };

  const handleDragEnd = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) {
      return;
    }

    dragRef.current = null;
    if (positionRef.current) {
      savePosition(positionRef.current);
    }
  };

  const floatingStyle = position
    ? {
        left: position.x,
        top: position.y,
      }
    : undefined;

  const statusBadge = (
    <span
      className={cn(
        "shrink-0 rounded-md bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground",
        status === "recording"
          ? "bg-primary/15 text-primary"
          : status === "ended"
            ? "bg-muted text-primary"
            : "",
      )}
    >
      {statusLabel(status)}
    </span>
  );

  const recordingTime = recordingStartedAt
    ? recordingStartedAt.toLocaleString()
    : null;

  const floatingEntry = isDialogVariant ? null : (
    <div
      className={cn(
        "fixed z-40 flex w-[17.5rem] flex-col overflow-hidden rounded-md border border-border/70 bg-background/95 text-sm shadow-lg backdrop-blur",
        position ? "" : "right-4 bottom-4",
      )}
      style={floatingStyle}
      data-testid="diagnostic-log-entry"
    >
      <div
        className="flex h-6 cursor-move items-center justify-center border-b border-border/70 bg-muted/35"
        onPointerDown={handleDragStart}
        onPointerMove={handleDragMove}
        onPointerUp={handleDragEnd}
        onPointerCancel={handleDragEnd}
        aria-label="Move diagnostic log entry"
      >
        <span className="text-muted-foreground/70">••••••</span>
      </div>
      <div className="flex flex-col gap-3 p-3">
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0 truncate font-semibold">AI 诊断日志</span>
          {statusBadge}
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          {statusDescription(status)}
        </p>
        {status === "recording" ? (
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              size="sm"
              onClick={handleStop}
              disabled={isBusy}
            >
              结束并上报
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={handleRestart}
              disabled={isBusy}
            >
              清空重来
            </Button>
          </div>
        ) : status === "ended" ? (
          <div className="flex flex-col gap-2">
            <Button
              type="button"
              size="sm"
              onClick={handleRestart}
              disabled={isBusy}
              className="w-full"
            >
              开始新记录
            </Button>
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={handleView}
                disabled={isBusy}
              >
                查看结果
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={handleDownload}
                disabled={isBusy || !result}
              >
                下载日志
              </Button>
            </div>
          </div>
        ) : (
          <Button
            type="button"
            size="sm"
            onClick={handleStart}
            disabled={isBusy}
            className="w-full"
          >
            开始记录
          </Button>
        )}
        {message ? (
          <p className="text-xs text-muted-foreground">{message}</p>
        ) : null}
      </div>
    </div>
  );

  return (
    <>
      {floatingEntry}

      <Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/45 backdrop-blur-sm" />
          <Dialog.Content className="fixed top-[50%] left-[50%] z-50 flex max-h-[84vh] w-[min(48rem,calc(100vw-2rem))] translate-x-[-50%] translate-y-[-50%] flex-col gap-4 rounded-md border border-border bg-background p-4 shadow-xl">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Dialog.Title className="text-lg font-semibold">
                    日志上报
                  </Dialog.Title>
                  {statusBadge}
                </div>
                <Dialog.Description className="max-w-2xl text-sm leading-6 text-muted-foreground">
                  开始记录后复现问题，结束时会把本轮 Web 与服务端诊断日志保存到服务端目录。
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <Button type="button" variant="secondary" size="sm">
                  关闭
                </Button>
              </Dialog.Close>
            </div>

            <div className="flex flex-col gap-3 rounded-md border border-border/70 bg-muted/20 p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 text-sm">
                  <p className="font-medium text-foreground">
                    {statusDescription(status)}
                  </p>
                  {recordingTime ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      记录开始时间：{recordingTime}
                    </p>
                  ) : null}
                </div>
                {status === "recording" ? (
                  <Button
                    type="button"
                    onClick={handleStop}
                    disabled={isBusy}
                    className="shrink-0"
                  >
                    {busyAction === "stop" ? "上报中..." : "结束并上报"}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    onClick={status === "ended" ? handleRestart : handleStart}
                    disabled={isBusy}
                    className="shrink-0"
                  >
                    {busyAction === "start" ? "开始中..." : "开始记录"}
                  </Button>
                )}
              </div>
              {message ? (
                <p className="text-sm text-muted-foreground">{message}</p>
              ) : null}
            </div>

            {result ? (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm text-muted-foreground">
                    本轮日志 {result.logs.length} 条
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={handleDownload}
                      disabled={isBusy}
                    >
                      下载日志
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={handleCopyResult}
                      disabled={!resultText}
                    >
                      复制日志正文
                    </Button>
                  </div>
                </div>
                <div className="flex flex-col gap-2 rounded-md border border-border/70 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium">服务端日志文件</span>
                    <Button
                      type="button"
                      size="sm"
                      onClick={handleCopyServerPath}
                      disabled={!serverPath}
                    >
                      {copied && serverPath ? "已复制" : "复制日志路径"}
                    </Button>
                  </div>
                  {serverPath ? (
                    <code className="break-all rounded-md bg-muted px-2 py-1.5 text-xs text-foreground">
                      {serverPath}
                    </code>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      已结束记录，但未返回服务端日志路径。
                    </p>
                  )}
                </div>
                <textarea
                  className="min-h-[14rem] resize-y rounded-md border border-border bg-muted/40 p-3 font-mono text-xs text-foreground outline-none focus:border-primary"
                  readOnly
                  value={resultText}
                  aria-label="Diagnostic log text"
                />
              </div>
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
