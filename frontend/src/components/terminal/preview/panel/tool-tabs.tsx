import { useEffect, useMemo, useState } from "react";
import { useMemoizedFn } from "ahooks";
import { useShallow } from "zustand/react/shallow";
import { ArrowLeft, ArrowRight, SlidersHorizontal } from "lucide-react";
import { isTerminalBrowserProfileId } from "@runweave/shared/terminal-browser-profile";
import { useTerminalPreviewStore, type TerminalSidecarTool } from "../../../../features/terminal/preview/store";
import {
  SIDECAR_TABS,
  createDefaultSidecarLayout,
  getActiveSidecarTab,
  getSidecarFallback,
  getVisibleSidecarTabs,
  type SidecarTabId,
} from "../../../../features/terminal/preview/sidecar-layout";
import { Button } from "../../../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../../../ui/popover";
import { SortableTabs, type SortableTabRenderProps } from "../../../ui/sortable-tabs";

const getTabId = (id: SidecarTabId) => id;

export function TerminalSidecarTabs({
  projectId,
  showAgentTeamTool,
  onSetActiveTool,
}: {
  projectId: string | null;
  showAgentTeamTool: boolean;
  onSetActiveTool: (tool: TerminalSidecarTool) => void;
}) {
  const {
    layout, error, activeTool, profileId, activateBrowser,
    setVisible, reorder, reset,
  } = useTerminalPreviewStore(useShallow((state) => ({
    layout: state.sidecarLayout,
    error: state.sidecarLayoutError,
    activeTool: state.ui.activeTool,
    profileId: state.activeBrowserProfileId,
    activateBrowser: state.activateBrowser,
    setVisible: state.setSidecarTabVisible,
    reorder: state.reorderSidecarTabs,
    reset: state.resetSidecarLayout,
  })));
  const isElectron = window.electronAPI?.isElectron === true;
  const available = useMemo(() => SIDECAR_TABS
    .filter((tab) => (tab.id !== "automation" || isElectron) && (tab.id !== "agent-team" || showAgentTeamTool))
    .map((tab) => tab.id), [isElectron, showAgentTeamTool]);
  const visible = getVisibleSidecarTabs(layout, available);
  const active = getActiveSidecarTab(activeTool, profileId);
  const [open, setOpen] = useState(false);
  const [automationCount, setAutomationCount] = useState(0);

  useEffect(() => {
    if (!isElectron) return;
    let alive = true;
    void window.electronAPI?.terminalBrowserAutomationGetSnapshot?.()
      .then((snapshot) => { if (alive) setAutomationCount(snapshot.connections.length); })
      .catch(() => { /* State-change events can still provide the count. */ });
    const unsubscribe = window.electronAPI?.onTerminalBrowserAutomationStateChanged?.(
      (snapshot) => setAutomationCount(snapshot.connections.length),
    );
    return () => { alive = false; unsubscribe?.(); };
  }, [isElectron]);

  const activate = useMemoizedFn((id: SidecarTabId) => {
    if (isTerminalBrowserProfileId(id)) activateBrowser(id, projectId);
    else onSetActiveTool(id);
  });
  // Capability changes and a saved layout can make the initial/current tool unavailable.
  useEffect(() => {
    const current = useTerminalPreviewStore.getState();
    const currentVisible = getVisibleSidecarTabs(current.sidecarLayout, available);
    const currentActive = getActiveSidecarTab(current.ui.activeTool, current.activeBrowserProfileId);
    if (!currentVisible.includes(currentActive)) {
      activate(getSidecarFallback(current.sidecarLayout, currentActive, currentVisible));
    }
  }, [active, layout, available, activate]);

  const toggleVisible = useMemoizedFn((id: SidecarTabId, checked: boolean) => {
    if (!checked && visible.length <= 1) return;
    if (!checked && active === id) {
      activate(getSidecarFallback(layout, id, visible.filter((candidate) => candidate !== id)));
    }
    setVisible(id, checked, available);
  });
  const restoreDefaults = useMemoizedFn(() => {
    const defaults = createDefaultSidecarLayout();
    const nextVisible = getVisibleSidecarTabs(defaults, available);
    if (!nextVisible.includes(active)) activate(getSidecarFallback(defaults, active, nextVisible));
    reset();
  });
  const label = (id: SidecarTabId) => id === "automation" && automationCount > 0
    ? `Automation · ${automationCount}`
    : SIDECAR_TABS.find((tab) => tab.id === id)!.label;
  const renderTab = useMemoizedFn((id: SidecarTabId, { isDragging }: SortableTabRenderProps) => (
    <button
      type="button"
      role={isDragging ? undefined : "tab"}
      aria-hidden={isDragging || undefined}
      aria-selected={isDragging ? undefined : active === id}
      tabIndex={isDragging ? -1 : undefined}
      data-testid={isDragging ? undefined : isTerminalBrowserProfileId(id)
        ? `terminal-browser-profile-${id}` : `terminal-sidecar-${id}`}
      className={`h-6 shrink-0 whitespace-nowrap rounded-sm px-2 text-xs ${active === id
        ? "bg-slate-700 text-slate-50" : "bg-slate-900 text-slate-400 hover:text-slate-100"}`}
      onClick={() => activate(id)}
    >
      {label(id)}
    </button>
  ));

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <div className="min-w-0 flex-1" role="tablist" aria-label="Sidecar tools">
        <SortableTabs
          items={visible}
          getItemId={getTabId}
          onReorder={(from, to) => reorder(available, from, to)}
          renderTab={renderTab}
          cancelOutside
          className="flex max-w-full overflow-x-auto rounded-md border border-slate-800 bg-slate-900/70 p-0.5"
        />
      </div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" size="sm" variant="ghost" className="h-7 w-7 shrink-0 px-0"
            aria-label="管理标签" title="管理标签">
            <SlidersHorizontal className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 max-w-[calc(100vw-16px)] rounded-lg p-3" aria-label="管理标签">
          <p className="mb-2 text-sm font-medium">管理标签</p>
          <p className="mb-3 text-xs text-muted-foreground">拖动标签排序；隐藏仅收起入口。</p>
          <div className="max-h-[60vh] overflow-y-auto">
            {layout.order.filter((id) => available.includes(id)).map((id) => {
              const checked = visible.includes(id);
              const index = visible.indexOf(id);
              return (
                <div key={id} className="flex items-center gap-1 py-1">
                  <label className="flex min-w-0 flex-1 items-center gap-2 text-xs">
                    <input type="checkbox" checked={checked} aria-label={`显示 ${label(id)}`}
                      disabled={checked && visible.length === 1}
                      onChange={(event) => toggleVisible(id, event.target.checked)} />
                    <span className="truncate">{label(id)}</span>
                  </label>
                  {checked ? <>
                    <Button type="button" size="sm" variant="ghost" className="h-6 w-6 px-0"
                      disabled={index === 0} aria-label={`前移 ${label(id)}`}
                      onClick={() => reorder(available, index, index - 1)}><ArrowLeft className="h-3 w-3" /></Button>
                    <Button type="button" size="sm" variant="ghost" className="h-6 w-6 px-0"
                      disabled={index === visible.length - 1} aria-label={`后移 ${label(id)}`}
                      onClick={() => reorder(available, index, index + 1)}><ArrowRight className="h-3 w-3" /></Button>
                  </> : <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-xs"
                    aria-label={`打开 ${label(id)}`} onClick={() => { activate(id); setOpen(false); }}>打开</Button>}
                </div>
              );
            })}
          </div>
          {visible.length === 1 ? <p className="mt-2 text-xs text-muted-foreground">至少保留一个可见标签</p> : null}
          {error ? <p role="alert" className="mt-2 text-xs text-amber-400">{error}</p> : null}
          <Button type="button" size="sm" variant="outline" className="mt-3 w-full text-xs" onClick={restoreDefaults}>
            恢复默认布局
          </Button>
        </PopoverContent>
      </Popover>
      {error ? <span role="status" className="sr-only">{error}</span> : null}
    </div>
  );
}
