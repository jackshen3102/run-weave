import type { TerminalBrowserGroupSnapshot } from "@runweave/shared/terminal-browser-workspace";
import { File, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import {
  useMemo,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { TerminalBrowserTabState } from "../../../../features/terminal/preview/store";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../../ui/alert-dialog";
import { Input } from "../../../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../../../ui/popover";
import {
  browserTabLabel,
  getBrowserGroupColor,
  getTerminalBrowserFaviconFallback,
} from "./utils";

interface TerminalBrowserTabOverviewProps {
  tabs: TerminalBrowserTabState[];
  groups: TerminalBrowserGroupSnapshot[];
  activeTabId: string;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (event: ReactMouseEvent<HTMLButtonElement>, tabId: string) => void;
  onCreateGroup: () => void;
  onRenameGroup: (groupId: string, name: string) => Promise<void>;
  onCloseGroup: (groupId: string) => Promise<void>;
}

export function TerminalBrowserTabOverview({
  tabs,
  groups,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onCreateGroup,
  onRenameGroup,
  onCloseGroup,
}: TerminalBrowserTabOverviewProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [pendingCloseGroupId, setPendingCloseGroupId] = useState<string | null>(
    null,
  );
  const [closingGroup, setClosingGroup] = useState(false);
  const tabsById = useMemo(() => new Map(tabs.map((tab) => [tab.id, tab])), [tabs]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredGroups = useMemo(
    () =>
      groups.flatMap((group) => {
        const groupMatches = [group.name, group.id].some((value) =>
          value.toLocaleLowerCase().includes(normalizedQuery),
        );
        const groupTabs = group.tabIds.flatMap((tabId) => {
          const tab = tabsById.get(tabId);
          if (!tab) {
            return [];
          }
          const tabMatches = [browserTabLabel(tab.title, tab.url), tab.url].some(
            (value) => value.toLocaleLowerCase().includes(normalizedQuery),
          );
          return !normalizedQuery || groupMatches || tabMatches ? [tab] : [];
        });
        return groupTabs.length > 0 ? [{ group, tabs: groupTabs }] : [];
      }),
    [groups, normalizedQuery, tabsById],
  );
  const pendingCloseGroup = pendingCloseGroupId
    ? groups.find((group) => group.id === pendingCloseGroupId) ?? null
    : null;

  const startRename = (group: TerminalBrowserGroupSnapshot): void => {
    setEditingGroupId(group.id);
    setNameDraft(group.name);
    setRenameError(null);
  };

  const saveRename = async (
    event: FormEvent<HTMLFormElement>,
    groupId: string,
  ): Promise<void> => {
    event.preventDefault();
    const normalizedName = nameDraft.trim();
    const length = Array.from(normalizedName).length;
    if (length < 1 || length > 40) {
      setRenameError("名称需为 1～40 个字符");
      return;
    }
    setRenaming(true);
    setRenameError(null);
    try {
      await onRenameGroup(groupId, normalizedName);
      setEditingGroupId(null);
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : "重命名失败");
    } finally {
      setRenaming(false);
    }
  };

  const requestCloseGroup = (group: TerminalBrowserGroupSnapshot): void => {
    if (group.tabIds.length > 1) {
      setPendingCloseGroupId(group.id);
      return;
    }
    void onCloseGroup(group.id);
  };

  const confirmCloseGroup = async (): Promise<void> => {
    if (!pendingCloseGroupId) {
      return;
    }
    setClosingGroup(true);
    try {
      await onCloseGroup(pendingCloseGroupId);
      setPendingCloseGroupId(null);
    } finally {
      setClosingGroup(false);
    }
  };

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) {
            setQuery("");
            setEditingGroupId(null);
            setRenameError(null);
          }
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            className="relative flex h-7 w-9 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-800 hover:text-slate-100"
            aria-label="搜索和管理浏览器页面"
            title="搜索和管理浏览器页面"
          >
            <Search className="h-3.5 w-3.5" />
            <span className="absolute right-0.5 top-0.5 min-w-3 rounded-full bg-slate-700 px-0.5 text-center text-[8px] leading-3 text-slate-200">
              {tabs.length}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-96 p-2">
          <div className="flex items-center gap-2">
            <Input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="搜索浏览器页面或工作组"
              placeholder="搜索页面或工作组"
              className="h-8 bg-slate-950 text-xs"
            />
            <button
              type="button"
              className="flex h-8 shrink-0 items-center gap-1 rounded-md border border-slate-700 px-2 text-xs text-slate-200 hover:bg-slate-800"
              onClick={() => {
                onCreateGroup();
                setOpen(false);
              }}
            >
              <Plus className="h-3.5 w-3.5" />
              新建工作组
            </button>
          </div>
          <div className="mt-2 max-h-80 space-y-2 overflow-y-auto">
            {filteredGroups.map(({ group, tabs: groupTabs }) => (
              <section
                key={group.id}
                className="rounded-md border border-slate-800 bg-slate-950/80 p-1.5"
                data-overview-group-id={group.id}
              >
                <div className="flex min-w-0 items-center gap-1.5 px-1 pb-1.5">
                  <span
                    className="h-1 w-5 shrink-0 rounded-full"
                    style={{ backgroundColor: getBrowserGroupColor(group.id) }}
                    aria-hidden="true"
                  />
                  {editingGroupId === group.id ? (
                    <form
                      className="min-w-0 flex-1"
                      onSubmit={(event) => void saveRename(event, group.id)}
                    >
                      <div className="flex gap-1">
                        <Input
                          autoFocus
                          value={nameDraft}
                          disabled={renaming}
                          aria-label="工作组名称"
                          className="h-7 bg-slate-900 text-xs"
                          onChange={(event) => {
                            setNameDraft(event.target.value);
                            setRenameError(null);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              setEditingGroupId(null);
                              setRenameError(null);
                            }
                          }}
                        />
                        <button
                          type="submit"
                          disabled={renaming}
                          className="h-7 rounded border border-slate-700 px-2 text-[10px] text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                        >
                          保存
                        </button>
                      </div>
                      {renameError ? (
                        <span className="mt-1 block text-[10px] text-red-300">
                          {renameError}
                        </span>
                      ) : null}
                    </form>
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-200">
                      {group.name}
                      <span className="ml-1 text-[10px] font-normal text-slate-500">
                        {group.tabIds.length}
                      </span>
                    </span>
                  )}
                  <button
                    type="button"
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-800 hover:text-slate-100"
                    aria-label={`重命名 ${group.name}`}
                    title="重命名工作组"
                    onClick={() => startRename(group)}
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-red-500/15 hover:text-red-300"
                    aria-label={`关闭工作组 ${group.name}`}
                    title="关闭工作组"
                    onClick={() => requestCloseGroup(group)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
                <div className="space-y-1">
                  {groupTabs.map((tab) => {
                    const label = browserTabLabel(tab.title, tab.url);
                    const faviconFallback = getTerminalBrowserFaviconFallback(tab.url);
                    return (
                      <div
                        key={tab.id}
                        className="flex min-w-0 items-center gap-1 rounded"
                        data-overview-tab-id={tab.id}
                      >
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-slate-800"
                          aria-current={tab.id === activeTabId ? "page" : undefined}
                          onClick={() => {
                            onSelectTab(tab.id);
                            setOpen(false);
                          }}
                        >
                          {tab.faviconDataUrl ? (
                            <img src={tab.faviconDataUrl} alt="" className="h-4 w-4" />
                          ) : faviconFallback ? (
                            <span className="flex h-4 w-4 items-center justify-center text-[10px] font-semibold text-slate-400">
                              {faviconFallback}
                            </span>
                          ) : (
                            <File className="h-4 w-4 shrink-0 text-slate-500" />
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs text-slate-100">
                              {label}
                            </span>
                            <span className="block truncate text-[10px] text-slate-500">
                              {tab.url || group.name}
                            </span>
                          </span>
                        </button>
                        <button
                          type="button"
                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-800 hover:text-slate-100"
                          aria-label={`关闭 ${label}`}
                          title={`关闭 ${label}`}
                          onClick={(event) => onCloseTab(event, tab.id)}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
            {filteredGroups.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-slate-500">
                没有匹配的页面或工作组
              </p>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
      <AlertDialog
        open={Boolean(pendingCloseGroup)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !closingGroup) {
            setPendingCloseGroupId(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>关闭工作组</AlertDialogTitle>
            <AlertDialogDescription>
              将关闭“{pendingCloseGroup?.name}”中的
              {pendingCloseGroup?.tabIds.length ?? 0} 个页面。此操作不会暂停已连接的 Agent。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={closingGroup}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={closingGroup}
              onClick={(event) => {
                event.preventDefault();
                void confirmCloseGroup();
              }}
            >
              关闭工作组
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
