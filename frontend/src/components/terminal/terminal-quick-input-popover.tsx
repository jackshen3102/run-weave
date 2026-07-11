import { useMemoizedFn } from "ahooks";
import { useEffect, useMemo, useState } from "react";
import type {
  TerminalQuickInputItem,
  TerminalQuickInputListKind,
  TerminalQuickInputMode,
} from "@runweave/shared/terminal/input";
import type { TerminalProjectListItem } from "@runweave/shared/terminal/project";
import type { TerminalSessionListItem } from "@runweave/shared/terminal/session";
import { Check, Plus, Search, Zap } from "lucide-react";
import {
  createTerminalQuickInput,
  deleteTerminalQuickInput,
  listTerminalQuickInputs,
  markTerminalQuickInputUsed,
  sendTerminalInput,
  updateTerminalQuickInput,
} from "../../services/terminal";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import {
  buildQuickInputTitle,
  canInsertRaw,
  TerminalQuickInputRow,
} from "./terminal-quick-input-row";

interface TerminalQuickInputPopoverProps {
  apiBase: string;
  token: string;
  activeProject: TerminalProjectListItem | null;
  activeSession: TerminalSessionListItem | null;
  disabled?: boolean;
}

const TABS: Array<{ value: TerminalQuickInputListKind; label: string }> = [
  { value: "pinned", label: "固定" },
  { value: "recent", label: "最近" },
  { value: "all", label: "全部" },
];

const MODE_OPTIONS: Array<{ value: TerminalQuickInputMode; label: string }> = [
  { value: "line", label: "line" },
  { value: "codex_slash_command", label: "codex_slash_command" },
  { value: "prompt_paste", label: "prompt_paste" },
];

type ManualQuickInputScope = "project" | "global";

export function TerminalQuickInputPopover({
  apiBase,
  token,
  activeProject,
  activeSession,
  disabled,
}: TerminalQuickInputPopoverProps) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<TerminalQuickInputListKind>("pinned");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [items, setItems] = useState<TerminalQuickInputItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualTitle, setManualTitle] = useState("");
  const [manualData, setManualData] = useState("");
  const [manualMode, setManualMode] = useState<TerminalQuickInputMode>("line");
  const [manualScope, setManualScope] =
    useState<ManualQuickInputScope>("project");
  const [savingManual, setSavingManual] = useState(false);

  const activeTerminalId = activeSession?.terminalSessionId ?? null;
  const canTargetTerminal = Boolean(activeTerminalId) && !disabled;
  const manualIsGlobal = manualScope === "global" || !activeProject;

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedQuery(query);
    }, 250);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [query]);

  const refresh = useMemoizedFn(async (): Promise<void> => {
    if (!open) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const payload = await listTerminalQuickInputs(apiBase, token, {
        projectId: activeProject?.projectId ?? null,
        q: debouncedQuery,
        kind,
        limit: 50,
      });
      setItems(payload.items);
    } catch (caught) {
      setItems([]);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  });

  useEffect(() => {
    void refresh();
  }, [activeProject?.projectId, debouncedQuery, kind, open, refresh]);

  const handleSend = useMemoizedFn(
    async (item: TerminalQuickInputItem): Promise<void> => {
      if (!activeTerminalId || !canTargetTerminal) {
        return;
      }
      setBusyItemId(item.id);
      setFeedback(null);
      setError(null);
      try {
        await sendTerminalInput(apiBase, token, activeTerminalId, {
          data: item.data,
          mode: item.mode,
          quickInputSource: "web_terminal_quick_input",
        });
        setFeedback("Sent");
        await refresh();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusyItemId(null);
      }
    },
  );

  const handleInsert = useMemoizedFn(
    async (item: TerminalQuickInputItem): Promise<void> => {
      if (!activeTerminalId || !canTargetTerminal || !canInsertRaw(item)) {
        return;
      }
      setBusyItemId(item.id);
      setFeedback(null);
      setError(null);
      try {
        await sendTerminalInput(apiBase, token, activeTerminalId, {
          data: item.data,
          mode: "raw",
          quickInputSource: "web_terminal_quick_input",
        });
        await markTerminalQuickInputUsed(apiBase, token, item.id);
        setFeedback("Inserted");
        await refresh();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusyItemId(null);
      }
    },
  );

  const handleCopy = useMemoizedFn(
    async (item: TerminalQuickInputItem): Promise<void> => {
      setBusyItemId(item.id);
      setFeedback(null);
      setError(null);
      try {
        await navigator.clipboard.writeText(item.data);
        await markTerminalQuickInputUsed(apiBase, token, item.id);
        setFeedback("Copied");
        await refresh();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusyItemId(null);
      }
    },
  );

  const handleTogglePinned = useMemoizedFn(
    async (item: TerminalQuickInputItem): Promise<void> => {
      setBusyItemId(item.id);
      setError(null);
      try {
        await updateTerminalQuickInput(apiBase, token, item.id, {
          pinned: !item.pinned,
        });
        await refresh();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusyItemId(null);
      }
    },
  );

  const handleDelete = useMemoizedFn(
    async (item: TerminalQuickInputItem): Promise<void> => {
      setBusyItemId(item.id);
      setError(null);
      try {
        await deleteTerminalQuickInput(apiBase, token, item.id);
        await refresh();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusyItemId(null);
      }
    },
  );

  const handleCreateManual = useMemoizedFn(async (): Promise<void> => {
    if (!manualData.trim() || savingManual) {
      return;
    }
    setSavingManual(true);
    setFeedback(null);
    setError(null);
    try {
      const item = await createTerminalQuickInput(apiBase, token, {
        title: manualTitle.trim() || buildQuickInputTitle(manualData),
        data: manualData,
        mode: manualMode,
        projectId: manualIsGlobal ? null : (activeProject?.projectId ?? null),
        terminalSessionId: manualIsGlobal
          ? null
          : (activeSession?.terminalSessionId ?? null),
        cwd: manualIsGlobal ? null : (activeSession?.cwd ?? null),
      });
      setManualTitle("");
      setManualData("");
      setManualMode("line");
      setKind("pinned");
      setQuery("");
      setDebouncedQuery("");
      setItems((currentItems) => [
        item,
        ...currentItems.filter((candidate) => candidate.id !== item.id),
      ]);
      setFeedback("Saved");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSavingManual(false);
    }
  });

  const emptyMessage = useMemo(() => {
    if (debouncedQuery.trim()) {
      return "没有匹配的快捷指令";
    }
    if (kind === "pinned") {
      return "还没有固定快捷指令";
    }
    if (kind === "recent") {
      return "还没有最近输入";
    }
    return "还没有快捷指令";
  }, [debouncedQuery, kind]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="快捷指令"
          title="快捷指令"
          className="h-6 w-6 shrink-0 rounded-md px-0 text-slate-300 hover:bg-slate-800 hover:text-slate-100"
        >
          <Zap className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[420px] rounded-lg border-slate-800 bg-slate-950 p-3 text-slate-100 shadow-[0_24px_80px_-34px_rgba(2,6,23,0.95)]"
      >
        <div
          className="flex flex-col gap-3"
          data-testid="terminal-quick-input-popover"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium text-slate-100">快捷指令</h2>
            {feedback ? (
              <span className="inline-flex items-center gap-1 text-[11px] text-slate-300">
                <Check className="h-3 w-3 text-emerald-300" />
                {feedback}
              </span>
            ) : null}
          </div>

          <label className="relative block">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
            <Input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              placeholder="搜索最近输入或模板"
              className="h-8 border-slate-800 bg-slate-900 pl-7 text-xs text-slate-100 placeholder:text-slate-500"
            />
          </label>

          <div className="grid grid-cols-3 rounded-md border border-slate-800 bg-slate-900 p-0.5">
            {TABS.map((tab) => (
              <button
                key={tab.value}
                type="button"
                className={[
                  "h-7 rounded px-2 text-xs transition-colors",
                  kind === tab.value
                    ? "bg-slate-700 text-slate-50"
                    : "text-slate-400 hover:bg-slate-800 hover:text-slate-100",
                ].join(" ")}
                onClick={() => {
                  setKind(tab.value);
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {error ? (
            <p className="rounded-md border border-rose-900/70 bg-rose-950/40 px-2 py-1.5 text-[11px] leading-4 text-rose-200">
              {error}
            </p>
          ) : null}

          <div className="max-h-[360px] overflow-auto pr-1">
            {loading ? (
              <div className="py-8 text-center text-xs text-slate-400">
                Loading...
              </div>
            ) : items.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-400">
                {emptyMessage}
              </div>
            ) : (
              <div className="space-y-2">
                {items.map((item) => (
                  <TerminalQuickInputRow
                    key={item.id}
                    item={item}
                    busy={busyItemId === item.id}
                    canTargetTerminal={canTargetTerminal}
                    onSend={handleSend}
                    onInsert={handleInsert}
                    onCopy={handleCopy}
                    onTogglePinned={handleTogglePinned}
                    onDelete={handleDelete}
                  />
                ))}
              </div>
            )}
          </div>

          {!activeTerminalId ? (
            <p className="text-[11px] leading-4 text-amber-300">
              Active terminal is required for send and insert.
            </p>
          ) : null}

          <div className="border-t border-slate-800 pt-3">
            <button
              type="button"
              className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-slate-300 transition-colors hover:bg-slate-800 hover:text-slate-100"
              onClick={() => {
                setManualOpen((value) => !value);
              }}
            >
              <Plus className="h-3.5 w-3.5" />
              保存快捷指令
            </button>

            {manualOpen ? (
              <div className="mt-2 space-y-2 rounded-md border border-slate-800 bg-slate-900/70 p-2">
                <div className="grid grid-cols-[minmax(0,1fr)_110px_150px] gap-2">
                  <label className="flex flex-col gap-1 text-[11px] text-slate-400">
                    标题
                    <Input
                      value={manualTitle}
                      onChange={(event) => {
                        setManualTitle(event.target.value);
                      }}
                      placeholder="可选"
                      className="h-8 border-slate-800 bg-slate-950 text-xs text-slate-100 placeholder:text-slate-500"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[11px] text-slate-400">
                    范围
                    <select
                      value={activeProject ? manualScope : "global"}
                      className="h-8 rounded-md border border-slate-800 bg-slate-950 px-2 text-xs text-slate-100 outline-none focus:border-sky-600"
                      onChange={(event) => {
                        setManualScope(
                          event.target.value as ManualQuickInputScope,
                        );
                      }}
                    >
                      <option value="project" disabled={!activeProject}>
                        当前项目
                      </option>
                      <option value="global">全局</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-[11px] text-slate-400">
                    Mode
                    <select
                      value={manualMode}
                      className="h-8 rounded-md border border-slate-800 bg-slate-950 px-2 text-xs text-slate-100 outline-none focus:border-sky-600"
                      onChange={(event) => {
                        setManualMode(
                          event.target.value as TerminalQuickInputMode,
                        );
                      }}
                    >
                      {MODE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="flex flex-col gap-1 text-[11px] text-slate-400">
                  内容
                  <textarea
                    value={manualData}
                    onChange={(event) => {
                      setManualData(event.target.value);
                    }}
                    placeholder="输入要保存的快捷指令"
                    className="min-h-20 resize-y rounded-md border border-slate-800 bg-slate-950 px-2 py-1.5 font-mono text-xs leading-4 text-slate-100 outline-none placeholder:text-slate-500 focus:border-sky-600"
                  />
                </label>
                <div className="flex items-center justify-end gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="h-7 rounded-md px-2 text-xs"
                    disabled={savingManual}
                    onClick={() => {
                      setManualOpen(false);
                    }}
                  >
                    取消
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 rounded-md px-2 text-xs"
                    disabled={!manualData.trim() || savingManual}
                    onClick={() => void handleCreateManual()}
                  >
                    保存
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
