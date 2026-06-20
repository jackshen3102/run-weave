import { useMemoizedFn } from "ahooks";
import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useState } from "react";
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
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type BusyAction = "start" | "stop" | "refresh" | "download" | null;

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
  open,
  onOpenChange,
}: DiagnosticLogEntryProps) {
  const [status, setStatus] = useState<DiagnosticLogStatus>(
    frontendDiagnosticLogRecorder.getStatus(),
  );
  const [result, setResult] = useState<DiagnosticLogResult | null>(
    frontendDiagnosticLogRecorder.getResult(),
  );
  const [recordingStartedAt, setRecordingStartedAt] = useState<Date | null>(
    null,
  );
  const [message, setMessage] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [copied, setCopied] = useState(false);

  const resultText = useMemo(() => formatDiagnosticLogResult(result), [result]);
  const serverPath = useMemo(() => serverPathFromResult(result), [result]);
  const isBusy = busyAction !== null;

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
    if (!open) {
      return;
    }
    void loadState();
  }, [loadState, open]);

  const handleStart = useMemoizedFn(async () => {
    setBusyAction("start");
    setMessage(null);
    setCopied(false);
    try {
      const response = await startDiagnosticLogs(apiBase, token);
      frontendDiagnosticLogRecorder.start();
      aiDiagnosticLog("diagnostic recording started", {
        trigger: "terminal_more_menu",
      });
      setStatus(response.status);
      setResult(null);
      setRecordingStartedAt(parseDate(response.startedAt) ?? new Date());
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
        trigger: "terminal_more_menu",
      });
      const stoppedResult = await stopDiagnosticLogs(
        apiBase,
        token,
        frontendDiagnosticLogRecorder.getBufferedLogs(),
      );
      frontendDiagnosticLogRecorder.finish(stoppedResult);
      setRecordingStartedAt(null);
      syncFromRecorder();
      onOpenChange(true);
      setMessage(serverPathFromResult(stoppedResult) ? "已结束记录并上报。" : null);
    } catch (error) {
      setMessage(formatActionError("结束并上报", error));
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
        trigger: "terminal_more_menu",
      });
      setStatus(response.status);
      setResult(null);
      setRecordingStartedAt(parseDate(response.startedAt) ?? new Date());
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

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
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
  );
}
