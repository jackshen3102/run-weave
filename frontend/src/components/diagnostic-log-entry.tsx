import * as Dialog from "@radix-ui/react-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import type {
  DiagnosticLogResult,
  DiagnosticLogStatus,
} from "@browser-viewer/shared";
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
}

interface FloatingPosition {
  x: number;
  y: number;
}

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
}: DiagnosticLogEntryProps) {
  const [status, setStatus] = useState<DiagnosticLogStatus>(
    frontendDiagnosticLogRecorder.getStatus(),
  );
  const [result, setResult] = useState<DiagnosticLogResult | null>(
    frontendDiagnosticLogRecorder.getResult(),
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
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

  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  useEffect(() => {
    let cancelled = false;

    const loadInitialState = async (): Promise<void> => {
      try {
        const [statusResponse, latestResult] = await Promise.all([
          getDiagnosticLogStatus(apiBase, token),
          getDiagnosticLogResult(apiBase, token),
        ]);

        if (cancelled) {
          return;
        }

        if (statusResponse.status === "recording") {
          frontendDiagnosticLogRecorder.start();
          setStatus("recording");
          setResult(null);
          return;
        }

        frontendDiagnosticLogRecorder.setResult(latestResult);
        setStatus(frontendDiagnosticLogRecorder.getStatus());
        setResult(frontendDiagnosticLogRecorder.getResult());
      } catch (error) {
        if (!cancelled) {
          setError(formatActionError("加载诊断日志", error));
        }
      }
    };

    void loadInitialState();

    return () => {
      cancelled = true;
    };
  }, [apiBase, token]);

  const syncFromRecorder = useCallback(() => {
    setStatus(frontendDiagnosticLogRecorder.getStatus());
    setResult(frontendDiagnosticLogRecorder.getResult());
  }, []);

  const handleStart = useCallback(async () => {
    setIsBusy(true);
    setError(null);
    try {
      await startDiagnosticLogs(apiBase, token);
      frontendDiagnosticLogRecorder.start();
      aiDiagnosticLog("diagnostic recording started", { trigger: "ui" });
      setDialogOpen(false);
      syncFromRecorder();
    } catch (error) {
      setError(formatActionError("开始记录", error));
    } finally {
      setIsBusy(false);
    }
  }, [apiBase, syncFromRecorder, token]);

  const handleStop = useCallback(async () => {
    setIsBusy(true);
    setError(null);
    try {
      aiDiagnosticLog("diagnostic recording stopping", { trigger: "ui" });
      const stoppedResult = await stopDiagnosticLogs(
        apiBase,
        token,
        frontendDiagnosticLogRecorder.getBufferedLogs(),
      );
      frontendDiagnosticLogRecorder.finish(stoppedResult);
      syncFromRecorder();
      setDialogOpen(true);
    } catch (error) {
      setError(formatActionError("结束记录", error));
    } finally {
      setIsBusy(false);
    }
  }, [apiBase, syncFromRecorder, token]);

  const handleView = useCallback(async () => {
    setIsBusy(true);
    setError(null);
    try {
      const latestResult = await getDiagnosticLogResult(apiBase, token);
      frontendDiagnosticLogRecorder.setResult(latestResult);
      syncFromRecorder();
      setDialogOpen(Boolean(latestResult));
    } catch (error) {
      setError(formatActionError("查看结果", error));
    } finally {
      setIsBusy(false);
    }
  }, [apiBase, syncFromRecorder, token]);

  const handleDownload = useCallback(async () => {
    setIsBusy(true);
    setError(null);
    try {
      const blob = await downloadDiagnosticLogs(apiBase, token);
      downloadBlob(blob);
    } catch (error) {
      setError(formatActionError("下载日志", error));
    } finally {
      setIsBusy(false);
    }
  }, [apiBase, token]);

  const handleRestart = useCallback(async () => {
    setIsBusy(true);
    setError(null);
    try {
      await startDiagnosticLogs(apiBase, token);
      frontendDiagnosticLogRecorder.start();
      aiDiagnosticLog("diagnostic recording restarted", { trigger: "ui" });
      setDialogOpen(false);
      syncFromRecorder();
    } catch (error) {
      setError(formatActionError("重新开始", error));
    } finally {
      setIsBusy(false);
    }
  }, [apiBase, syncFromRecorder, token]);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard?.writeText(resultText);
  }, [resultText]);

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

  return (
    <>
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
                结束记录
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
          {error ? (
            <p className="text-xs text-muted-foreground">{error}</p>
          ) : null}
        </div>
      </div>

      <Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/45 backdrop-blur-sm" />
          <Dialog.Content className="fixed top-[50%] left-[50%] z-50 flex max-h-[84vh] w-[min(48rem,calc(100vw-2rem))] translate-x-[-50%] translate-y-[-50%] flex-col gap-4 rounded-md border border-border bg-background p-4 shadow-xl">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-col gap-1">
                <Dialog.Title className="text-lg font-semibold">
                  本次 AI 诊断日志
                </Dialog.Title>
                <Dialog.Description className="text-sm text-muted-foreground">
                  {result?.logs.length ?? 0} entries
                </Dialog.Description>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={handleCopy}
                  disabled={!resultText}
                >
                  复制
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={handleDownload}
                  disabled={!result}
                >
                  下载日志
                </Button>
                <Dialog.Close asChild>
                  <Button type="button" variant="secondary" size="sm">
                    关闭
                  </Button>
                </Dialog.Close>
              </div>
            </div>
            <textarea
              className="min-h-[18rem] resize-y rounded-md border border-border bg-muted/40 p-3 font-mono text-xs text-foreground outline-none focus:border-primary"
              readOnly
              value={resultText}
              aria-label="Diagnostic log text"
            />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
