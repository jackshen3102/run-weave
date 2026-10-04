import { useMemoizedFn } from "ahooks";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { ScheduledRun } from "@runweave/shared/scheduled-tasks";
import type { TerminalQuickInputItem } from "@runweave/shared/terminal/input";
import type { TerminalProjectListItem } from "@runweave/shared/terminal/project";
import type { TerminalSessionListItem } from "@runweave/shared/terminal/session";
import { AlertTriangle, ChevronRight, Plus, Search, Zap } from "lucide-react";
import {
  deleteTerminalQuickInput,
  listTerminalQuickInputs,
  startTerminalQuickInputRun,
  markTerminalQuickInputUsed,
  sendTerminalInput,
} from "../../../services/terminal";
import { moveTerminalQuickInput } from "../../../services/terminal/quick-inputs";
import { scheduledTasksApi } from "../../../services/scheduled-tasks";
import { HttpError } from "../../../services/http";
import {
  QuickInputRunPanel,
  QuickInputRunRow,
} from "../../../features/scheduled-tasks/quick-input-run-panel";
import {
  isQuickInputRunActive,
  quickInputRunNeedsAttention,
  useQuickInputBackgroundRuns,
} from "../../../features/scheduled-tasks/use-quick-input-background-runs";
import { RequestError } from "../../../features/scheduled-tasks/presentation";
import { useTerminalRuntime } from "../../../features/terminal/queries/provider";
import { useRuntimeStatus } from "../../../features/runtime-status/use-runtime-status";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";
import { Tooltip } from "../../ui/tooltip";
import { canInsertRaw, TerminalQuickInputRow } from "./quick-input-row";
import { QuickInputEditor } from "./quick-input-editor";

interface TerminalQuickInputPopoverProps {
  apiBase: string;
  token: string;
  connectionName?: string;
  activeProject: TerminalProjectListItem | null;
  activeSession: TerminalSessionListItem | null;
  disabled?: boolean;
}

export function TerminalQuickInputPopover({
  apiBase,
  token,
  connectionName = "当前电脑",
  activeProject,
  activeSession,
  disabled,
}: TerminalQuickInputPopoverProps) {
  const { scope } = useTerminalRuntime();
  const [open, setOpen] = useState(false);
  const [runsOpen, setRunsOpen] = useState(false);
  const [selectedRun, setSelectedRun] = useState<ScheduledRun | null>(null);
  const [editor, setEditor] = useState<{
    item: TerminalQuickInputItem | null;
  } | null>(null);
  const [query, setQuery] = useState("");
  const [sorting, setSorting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const busy = useRef(false);
  const [needsBackgroundConfig, setNeedsBackgroundConfig] = useState(false);
  const pendingRunKeys = useRef(new Map<string, string>());
  const { setPanelOpen } = useRuntimeStatus();
  const runs = useQuickInputBackgroundRuns(open || runsOpen);
  const commands = useQuery({
    queryKey: ["connection", scope, "global-quick-inputs"],
    enabled: open,
    queryFn: async ({ signal }) => {
      const items: TerminalQuickInputItem[] = [];
      let cursor: string | undefined;
      let orderVersion: string | undefined;
      do {
        const page = await listTerminalQuickInputs(
          apiBase,
          token,
          {
            scope: "global",
            order: "manual",
            kind: "pinned",
            limit: 100,
            cursor,
          },
          signal,
        );
        if (
          !page.orderVersion ||
          (orderVersion && page.orderVersion !== orderVersion)
        )
          throw new Error("快捷指令列表已变化或电脑版本过旧，请重新读取。");
        items.push(...page.items);
        orderVersion = page.orderVersion;
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return { items, orderVersion };
    },
  });
  const items = commands.data?.items ?? [];
  const visible = items.filter((item) =>
    `${item.title}\n${item.data}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const canTargetTerminal =
    Boolean(
      activeSession && activeSession.projectId === activeProject?.projectId,
    ) && !disabled;
  const attentionCount = runs.dashboardRuns.filter(
    quickInputRunNeedsAttention,
  ).length;

  const action = useMemoizedFn(
    async (item: TerminalQuickInputItem, operation: () => Promise<void>) => {
      if (busy.current) return;
      busy.current = true;
      setBusyItemId(item.id);
      setError(null);
      setFeedback(null);
      try {
        await operation();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        busy.current = false;
        setBusyItemId(null);
      }
    },
  );
  const send = useMemoizedFn((item: TerminalQuickInputItem, insert = false) => {
    if (!activeSession || !canTargetTerminal || (insert && !canInsertRaw(item)))
      return;
    void action(item, async () => {
      await sendTerminalInput(apiBase, token, activeSession.terminalSessionId, {
        data: item.data,
        mode: insert ? "raw" : item.mode,
        recordQuickInput: false,
        quickInputSource: "web_terminal_quick_input",
      });
      await markTerminalQuickInputUsed(apiBase, token, item.id);
      setFeedback(insert ? "已插入终端" : "已发送到终端");
    });
  });
  const showRuns = useMemoizedFn((run: ScheduledRun | null) => {
    setSelectedRun(run);
    setOpen(false);
    setRunsOpen(true);
  });
  const start = useMemoizedFn((item: TerminalQuickInputItem) => {
    const projectId = activeProject?.projectId;
    if (!projectId || !canTargetTerminal) return;
    void action(item, async () => {
      const keyScope = `${scope}:${projectId}:${item.id}:${item.updatedAt}`;
      const storageKey = `runweave:quick-input-run:${keyScope}`;
      let savedKey: string | null = null;
      try {
        savedKey = sessionStorage.getItem(storageKey);
      } catch {
        /* unavailable */
      }
      const key =
        pendingRunKeys.current.get(keyScope) ?? savedKey ?? crypto.randomUUID();
      pendingRunKeys.current.set(keyScope, key);
      try {
        sessionStorage.setItem(storageKey, key);
      } catch {
        /* unavailable */
      }
      const clearKey = () => {
        pendingRunKeys.current.delete(keyScope);
        try {
          sessionStorage.removeItem(storageKey);
        } catch {
          /* unavailable */
        }
      };
      setFeedback("提交中");
      setNeedsBackgroundConfig(false);
      try {
        const run = await startTerminalQuickInputRun(
          apiBase,
          token,
          item.id,
          { projectId, expectedInputUpdatedAt: item.updatedAt },
          key,
        );
        clearKey();
        runs.upsertBackgroundRun(run);
        setFeedback("已提交后台运行");
      } catch (caught) {
        const details =
          caught instanceof HttpError
            ? (caught.details as { runId?: unknown } | undefined)
            : undefined;
        if (
          caught instanceof HttpError &&
          caught.code === "run_busy" &&
          typeof details?.runId === "string"
        ) {
          const run = await scheduledTasksApi(apiBase, token).run(
            details.runId,
          );
          clearKey();
          runs.upsertBackgroundRun(run);
          showRuns(run);
        } else {
          setNeedsBackgroundConfig(
            caught instanceof HttpError && caught.code === "config_required",
          );
          if (caught instanceof HttpError && caught.status < 500) clearKey();
          setFeedback(
            caught instanceof HttpError && caught.status < 500
              ? null
              : "提交尚未确认，请重试确认同一次运行",
          );
          throw caught;
        }
      }
    });
  });
  const edit = useMemoizedFn((item: TerminalQuickInputItem | null) => {
    setOpen(false);
    setEditor({ item });
  });
  const move = useMemoizedFn(
    (item: TerminalQuickInputItem, direction: -1 | 1) => {
      const index = items.findIndex((candidate) => candidate.id === item.id);
      const version = commands.data?.orderVersion;
      if (
        !version ||
        index + direction < 0 ||
        index + direction >= items.length
      )
        return;
      void action(item, async () => {
        try {
          await moveTerminalQuickInput(
            apiBase,
            token,
            item.id,
            direction === -1
              ? items[index - 1]!.id
              : (items[index + 2]?.id ?? null),
            version,
          );
        } finally {
          await commands.refetch();
        }
      });
    },
  );

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip content="快捷指令">
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="快捷指令"
              className="h-6 w-6 shrink-0 rounded-md px-0 text-slate-300 hover:bg-slate-800"
            >
              <Zap className="h-3.5 w-3.5" />
            </Button>
          </PopoverTrigger>
        </Tooltip>
        <PopoverContent
          align="end"
          className="w-[440px] max-w-[calc(100vw-24px)] border-slate-800 bg-slate-950 p-4 text-slate-100"
        >
          <div
            className="max-h-[min(720px,75vh)] space-y-4 overflow-y-auto pr-1"
            data-testid="terminal-quick-input-popover"
          >
            <p className="text-xs text-slate-400">{connectionName} · 全局</p>
            <section className="space-y-2" aria-label="后台任务">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">
                  后台任务{" "}
                  <span className="font-normal text-slate-400">
                    · {runs.dashboardRuns.length}
                  </span>
                </h2>
                <button
                  type="button"
                  className="flex items-center gap-1 text-xs text-sky-300"
                  onClick={() => showRuns(null)}
                >
                  {runs.dashboardRuns.length > 3
                    ? `查看全部 ${runs.dashboardRuns.length} 个`
                    : "全部"}
                  <ChevronRight className="h-3 w-3" />
                </button>
              </div>
              {attentionCount > 0 ? (
                <p className="flex items-center gap-1 text-xs text-orange-300">
                  <AlertTriangle className="h-3 w-3" />
                  {attentionCount} 项需处理
                </p>
              ) : null}
              <RequestError error={runs.error} />
              {runs.error ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void runs.refresh()}
                >
                  重试读取任务
                </Button>
              ) : runs.loading ? (
                <p className="py-2 text-xs text-slate-400">正在读取任务…</p>
              ) : !runs.dashboardRuns.length ? (
                <p className="py-2 text-xs text-slate-400">暂无后台任务</p>
              ) : null}
              {runs.dashboardRuns.slice(0, 3).map((run) => (
                <QuickInputRunRow
                  key={run.id}
                  run={run}
                  onSelect={() => showRuns(run)}
                />
              ))}
            </section>
            <section
              className="space-y-3 border-t border-slate-800 pt-4"
              aria-label="快捷指令列表"
            >
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">快捷指令</h2>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs text-sky-300"
                    disabled={
                      Boolean(busyItemId) || commands.isPending || !items.length
                    }
                    onClick={() => {
                      setSorting(!sorting);
                      setQuery("");
                    }}
                  >
                    {sorting ? "完成排序" : "管理排序"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-sky-300"
                    aria-label="新增指令"
                    onClick={() => edit(null)}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <p className="text-xs text-slate-400">
                当前执行位置：{activeProject?.name ?? "请先选择项目或工作区"}
              </p>
              {!sorting ? (
                <label className="relative block">
                  <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-slate-500" />
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索全局快捷指令"
                    className="h-8 border-slate-800 bg-slate-900 pl-7 text-xs"
                  />
                </label>
              ) : null}
              {error ? (
                <p role="alert" className="break-words text-xs text-rose-300">
                  {error}
                </p>
              ) : null}
              {feedback ? (
                <p role="status" className="text-xs text-sky-300">
                  {feedback}
                </p>
              ) : null}
              {needsBackgroundConfig ? (
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => {
                    setOpen(false);
                    setPanelOpen(true);
                  }}
                >
                  设置后台模型
                </Button>
              ) : null}
              <RequestError error={commands.error} />
              {commands.error ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void commands.refetch()}
                >
                  重试读取指令
                </Button>
              ) : commands.isPending ? (
                <p className="py-4 text-center text-xs text-slate-400">
                  正在读取…
                </p>
              ) : !visible.length ? (
                <p className="py-4 text-center text-xs text-slate-400">
                  {query.trim()
                    ? "没有匹配的快捷指令"
                    : "还没有快捷指令，点击新增保存常用命令。"}
                </p>
              ) : null}
              {visible.map((item, index) => {
                const run = runs.backgroundRuns.find(
                  (candidate) =>
                    !candidate.archivedAt &&
                    isQuickInputRunActive(candidate) &&
                    candidate.executionProjectId === activeProject?.projectId &&
                    candidate.snapshot.origin?.quickInputId === item.id,
                );
                return (
                  <TerminalQuickInputRow
                    key={item.id}
                    item={item}
                    busy={Boolean(busyItemId)}
                    canTargetTerminal={canTargetTerminal}
                    canBackgroundRun={
                      runs.backgroundAvailable && canTargetTerminal && !disabled
                    }
                    running={Boolean(run)}
                    sorting={sorting}
                    first={index === 0}
                    last={index === visible.length - 1}
                    onSend={send}
                    onInsert={(command) => send(command, true)}
                    onEdit={edit}
                    onBackgroundRun={start}
                    onViewRun={() => {
                      if (run) showRuns(run);
                    }}
                    onMove={(direction) => move(item, direction)}
                    onCopy={(command) =>
                      void action(command, async () => {
                        await navigator.clipboard.writeText(command.data);
                        await markTerminalQuickInputUsed(
                          apiBase,
                          token,
                          command.id,
                        );
                        setFeedback("已复制指令");
                      })
                    }
                    onDelete={(command) => {
                      if (
                        window.confirm(
                          "删除快捷指令？已创建的后台任务及运行记录会保留。",
                        )
                      )
                        void action(command, async () => {
                          await deleteTerminalQuickInput(
                            apiBase,
                            token,
                            command.id,
                          );
                          await commands.refetch();
                        });
                    }}
                  />
                );
              })}
            </section>
          </div>
        </PopoverContent>
      </Popover>
      <QuickInputRunPanel
        open={runsOpen}
        onOpenChange={(value) => {
          setRunsOpen(value);
          if (!value) setOpen(true);
        }}
        selectedRun={selectedRun}
        onSelect={setSelectedRun}
        dashboardRuns={runs.dashboardRuns}
        historyRuns={runs.historyRuns}
        loading={runs.loading}
        error={runs.error}
        onRefresh={() => void runs.refresh()}
        onUpdate={runs.upsertBackgroundRun}
        onOpened={() => {
          setRunsOpen(false);
          setOpen(false);
        }}
        connectionName={connectionName}
      />
      {editor ? (
        <QuickInputEditor
          key={editor.item?.id ?? "new"}
          item={editor.item}
          apiBase={apiBase}
          token={token}
          connectionName={connectionName}
          onClose={() => {
            setEditor(null);
            setOpen(true);
          }}
          onSaved={() => {
            setEditor(null);
            setOpen(true);
            void commands.refetch();
          }}
        />
      ) : null}
    </>
  );
}
