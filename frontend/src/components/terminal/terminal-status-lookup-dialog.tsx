import { useMemoizedFn } from "ahooks";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { AppServerThreadRef } from "@runweave/shared";
import { Search } from "lucide-react";
import {
  getAppServerThread,
  listAppServerThreads,
} from "../../services/app-server-state";
import { HttpError } from "../../services/http";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

type LookupMode = "thread" | "terminal";

interface TerminalStatusLookupDialogProps {
  apiBase: string;
  token: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeProjectId: string | null;
  activeSessionId: string | null;
  activePanelId: string | null;
}

const STATUS_RANK: Record<AppServerThreadRef["status"], number> = {
  running: 0,
  starting: 1,
  failed: 2,
  idle: 3,
  completed: 4,
  unknown: 5,
};

const DETAIL_FIELDS: Array<{
  label: string;
  read: (thread: AppServerThreadRef) => string | null;
}> = [
  { label: "status", read: (thread) => thread.status },
  { label: "threadId", read: (thread) => thread.threadId },
  { label: "agent", read: (thread) => thread.agent },
  { label: "terminalSessionId", read: (thread) => thread.terminalSessionId },
  { label: "terminalPanelId", read: (thread) => thread.terminalPanelId },
  { label: "projectId", read: (thread) => thread.projectId },
  { label: "runId", read: (thread) => thread.runId },
  { label: "lastEventId", read: (thread) => thread.lastEventId },
  { label: "lastHookEvent", read: (thread) => thread.lastHookEvent },
  {
    label: "lastCompletionReason",
    read: (thread) => thread.lastCompletionReason,
  },
  { label: "updatedAt", read: (thread) => thread.updatedAt },
  { label: "cwd", read: (thread) => thread.cwd },
  { label: "sourceInstanceId", read: (thread) => thread.sourceInstanceId },
];

function compareThreads(
  left: AppServerThreadRef,
  right: AppServerThreadRef,
): number {
  const statusDiff = STATUS_RANK[left.status] - STATUS_RANK[right.status];
  if (statusDiff !== 0) {
    return statusDiff;
  }
  return parseTime(right.updatedAt) - parseTime(left.updatedAt);
}

function parseTime(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function valueText(value: string | null | undefined): string {
  return value ?? "null";
}

function formatCandidate(thread: AppServerThreadRef): string {
  return `${thread.status} ${thread.agent} ${thread.threadId} panel=${valueText(
    thread.terminalPanelId,
  )} updatedAt=${thread.updatedAt}`;
}

function buildAgentPrompt(
  thread: AppServerThreadRef,
  candidates: AppServerThreadRef[],
): string {
  const lines = [
    "请帮我排查这个 Runweave App Server thread 当前状态：",
    `threadId: ${thread.threadId}`,
    `agent: ${thread.agent}`,
    `status: ${thread.status}`,
    `projectId: ${valueText(thread.projectId)}`,
    `terminalSessionId: ${valueText(thread.terminalSessionId)}`,
    `terminalPanelId: ${valueText(thread.terminalPanelId)}`,
    `runId: ${valueText(thread.runId)}`,
    `cwd: ${valueText(thread.cwd)}`,
    `lastEventId: ${thread.lastEventId}`,
    `lastHookEvent: ${valueText(thread.lastHookEvent)}`,
    `lastCompletionReason: ${valueText(thread.lastCompletionReason)}`,
    `updatedAt: ${thread.updatedAt}`,
    "",
    "请优先读取 App Server projection/latest thread 状态和相关 JSONL 事件，再判断是否需要继续查终端、hook 或日志。",
  ];

  if (candidates.length > 1) {
    lines.push(
      "",
      `同一个 terminalSessionId 下命中了 ${candidates.length} 条 ThreadRef：`,
      ...candidates.map((candidate) => `- ${formatCandidate(candidate)}`),
    );
  }

  return lines.join("\n");
}

function formatError(action: string, error: unknown): string {
  if (error instanceof HttpError) {
    if (error.status === 404) {
      return "未找到该 thread";
    }
    if (error.status === 503) {
      return "App Server 不可用";
    }
    return `${action}失败：${error.message}`;
  }
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

export function TerminalStatusLookupDialog({
  apiBase,
  token,
  open,
  onOpenChange,
  activeProjectId,
  activeSessionId,
  activePanelId,
}: TerminalStatusLookupDialogProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [mode, setMode] = useState<LookupMode>("terminal");
  const [threadInput, setThreadInput] = useState("");
  const [terminalInput, setTerminalInput] = useState("");
  const [threads, setThreads] = useState<AppServerThreadRef[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [manualCopyText, setManualCopyText] = useState<string | null>(null);

  const selectedThread = useMemo(
    () => threads.find((thread) => thread.threadId === selectedThreadId) ?? null,
    [selectedThreadId, threads],
  );
  const copyText = useMemo(
    () => (selectedThread ? buildAgentPrompt(selectedThread, threads) : ""),
    [selectedThread, threads],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    setMode("terminal");
    setThreadInput("");
    setTerminalInput(activeSessionId ?? "");
    setThreads([]);
    setSelectedThreadId(null);
    setMessage(null);
    setCopied(false);
    setManualCopyText(null);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [activeSessionId, open]);

  useEffect(() => {
    if (!copied) {
      return undefined;
    }
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const runSearch = useMemoizedFn(async (): Promise<void> => {
    const value = mode === "thread" ? threadInput.trim() : terminalInput.trim();
    setCopied(false);
    setManualCopyText(null);
    if (!value) {
      setThreads([]);
      setSelectedThreadId(null);
      setMessage(mode === "thread" ? "请输入 Thread ID" : "请输入 Terminal ID");
      return;
    }

    setLoading(true);
    setMessage(null);
    try {
      if (mode === "thread") {
        const response = await getAppServerThread(apiBase, token, value);
        setThreads([response.thread]);
        setSelectedThreadId(response.thread.threadId);
        return;
      }

      const response = await listAppServerThreads(apiBase, token, {
        terminalSessionId: value,
        limit: 100,
      });
      const sortedThreads = [...response.threads].sort(compareThreads);
      setThreads(sortedThreads);
      setSelectedThreadId(sortedThreads[0]?.threadId ?? null);
      if (sortedThreads.length === 0) {
        setMessage("未找到该 terminal 的 ThreadRef");
      }
    } catch (error) {
      setThreads([]);
      setSelectedThreadId(null);
      setMessage(formatError("查询状态", error));
    } finally {
      setLoading(false);
    }
  });

  const handleCopy = useMemoizedFn(async (): Promise<void> => {
    if (!copyText) {
      return;
    }
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      setManualCopyText(null);
    } catch {
      setManualCopyText(copyText);
      setMessage("复制失败，请手动选择下方文本。");
    }
  });

  const handleModeChange = useMemoizedFn((nextMode: LookupMode): void => {
    setMode(nextMode);
    setThreads([]);
    setSelectedThreadId(null);
    setMessage(null);
    setCopied(false);
    setManualCopyText(null);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  });

  const handleInputKeyDown = useMemoizedFn(
    (event: KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === "Enter") {
        event.preventDefault();
        void runSearch();
      }
    },
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[86vh] max-w-3xl overflow-hidden border-slate-800 bg-slate-950 text-slate-100">
        <DialogHeader>
          <DialogTitle>状态查询</DialogTitle>
          <DialogDescription>
            查询 App Server 投影出的轻量 ThreadRef 状态。
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-col gap-4 overflow-hidden">
          <div className="flex rounded-md border border-slate-800 bg-slate-900 p-1">
            <button
              type="button"
              className={[
                "h-8 flex-1 rounded px-3 text-sm",
                mode === "thread"
                  ? "bg-slate-700 text-slate-50"
                  : "text-slate-400 hover:text-slate-100",
              ].join(" ")}
              onClick={() => handleModeChange("thread")}
            >
              Thread ID
            </button>
            <button
              type="button"
              className={[
                "h-8 flex-1 rounded px-3 text-sm",
                mode === "terminal"
                  ? "bg-slate-700 text-slate-50"
                  : "text-slate-400 hover:text-slate-100",
              ].join(" ")}
              onClick={() => handleModeChange("terminal")}
            >
              Terminal ID
            </button>
          </div>

          <div className="flex gap-2">
            <Input
              ref={inputRef}
              value={mode === "thread" ? threadInput : terminalInput}
              placeholder={mode === "thread" ? "threadId" : "terminalSessionId"}
              onChange={(event) => {
                if (mode === "thread") {
                  setThreadInput(event.target.value);
                } else {
                  setTerminalInput(event.target.value);
                }
              }}
              onKeyDown={handleInputKeyDown}
              className="border-slate-800 bg-slate-950 text-slate-100"
            />
            <Button
              type="button"
              disabled={loading}
              onClick={() => void runSearch()}
              className="shrink-0"
            >
              <Search className="h-4 w-4" />
              查询
            </Button>
          </div>

          {activeProjectId || activeSessionId || activePanelId ? (
            <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-2 gap-y-1 rounded-md border border-slate-800 bg-slate-950/60 p-3 text-xs">
              <span className="text-slate-500">projectId</span>
              <span className="truncate text-slate-300">
                {valueText(activeProjectId)}
              </span>
              <span className="text-slate-500">terminalSessionId</span>
              <span className="truncate text-slate-300">
                {valueText(activeSessionId)}
              </span>
              <span className="text-slate-500">terminalPanelId</span>
              <span className="truncate text-slate-300">
                {valueText(activePanelId)}
              </span>
            </div>
          ) : null}

          {message ? (
            <p className="rounded-md border border-slate-800 bg-slate-900/70 px-3 py-2 text-sm text-slate-300">
              {message}
            </p>
          ) : null}

          <div className="grid min-h-0 gap-4 overflow-hidden lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <div className="min-h-0 overflow-auto rounded-md border border-slate-800">
              <div className="border-b border-slate-800 px-3 py-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                候选 ThreadRef
              </div>
              {threads.length > 0 ? (
                <div className="divide-y divide-slate-800">
                  {threads.map((thread) => (
                    <button
                      type="button"
                      key={thread.threadId}
                      className={[
                        "block w-full px-3 py-2 text-left text-sm hover:bg-slate-900",
                        selectedThreadId === thread.threadId
                          ? "bg-slate-900 text-slate-50"
                          : "text-slate-300",
                      ].join(" ")}
                      onClick={() => setSelectedThreadId(thread.threadId)}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium">
                          {thread.threadId}
                        </span>
                        <span className="shrink-0 rounded border border-slate-700 px-1.5 py-0.5 text-xs text-slate-300">
                          {thread.status}
                        </span>
                      </span>
                      <span className="mt-1 block truncate text-xs text-slate-500">
                        {thread.agent} / panel={valueText(thread.terminalPanelId)}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="px-3 py-6 text-sm text-slate-500">
                  输入 ID 后查询状态。
                </p>
              )}
            </div>

            <div className="min-h-0 overflow-auto rounded-md border border-slate-800">
              <div className="border-b border-slate-800 px-3 py-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                状态摘要
              </div>
              {selectedThread ? (
                <div className="grid grid-cols-[9rem_minmax(0,1fr)] gap-x-3 gap-y-2 p-3 text-sm">
                  {DETAIL_FIELDS.map((field) => (
                    <div key={field.label} className="contents">
                      <span className="text-slate-500">{field.label}</span>
                      <span className="min-w-0 break-words font-mono text-xs text-slate-200">
                        {valueText(field.read(selectedThread))}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="px-3 py-6 text-sm text-slate-500">
                  选中候选后显示详情。
                </p>
              )}
            </div>
          </div>

          {manualCopyText ? (
            <textarea
              readOnly
              value={manualCopyText}
              className="h-28 resize-none rounded-md border border-slate-800 bg-slate-950 p-3 font-mono text-xs text-slate-200"
            />
          ) : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            disabled={!selectedThread}
            onClick={() => void handleCopy()}
          >
            {copied ? "已复制" : "复制给 Agent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
