import { AlertTriangle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { RuntimeStatusCapabilityId } from "@runweave/shared/runtime-status";
import { useRuntimeStatus } from "../features/runtime-status/use-runtime-status";

const CAPABILITY_LABELS: Record<RuntimeStatusCapabilityId, string> = {
  node: "节点连接", terminal: "Terminal", feishu: "飞书接入",
  "app-server": "App Server", "workspace-services": "Workspace Services",
  desktop: "Desktop", "background-tasks": "后台任务",
};

export function RuntimeStatusNotice() {
  const { nodes, unhealthyCapabilityIds, setPanelOpen } = useRuntimeStatus();
  const previousRef = useRef(new Set<RuntimeStatusCapabilityId>());
  const [notice, setNotice] = useState<RuntimeStatusCapabilityId | null>(null);

  useEffect(() => {
    if (nodes.length === 0) return;
    const current = new Set(unhealthyCapabilityIds);
    const next = unhealthyCapabilityIds.find(
      (capabilityId) => !previousRef.current.has(capabilityId),
    );
    previousRef.current = current;
    if (!next) return;

    const showSystemNotification = async (): Promise<boolean> => {
      if (document.visibilityState === "visible" && document.hasFocus()) return false;
      try {
        return (await window.electronAPI?.showRuntimeStatusNotification?.({
          capabilityId: next,
          title: `${CAPABILITY_LABELS[next]}运行异常`,
          body: "请打开运行状态查看异常原因和受影响的功能。",
        })) ?? false;
      } catch {
        return false;
      }
    };
    void showSystemNotification().then((shown) => {
      if (!shown) setNotice(next);
    });
  }, [nodes.length, unhealthyCapabilityIds]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 8_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  if (!notice || !unhealthyCapabilityIds.includes(notice)) return null;
  return (
    <div role="status" aria-live="polite" className="fixed right-4 bottom-4 z-[70] flex w-[min(24rem,calc(100vw-2rem))] items-start gap-3 rounded-xl border border-red-500/40 bg-background p-4 text-foreground shadow-2xl" data-runtime-status-notice={notice}>
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => { setPanelOpen(true); setNotice(null); }}>
        <span className="block text-sm font-semibold">{CAPABILITY_LABELS[notice]}运行异常</span>
        <span className="mt-1 block text-xs text-muted-foreground">点击查看异常原因和受影响的功能。</span>
      </button>
      <button type="button" aria-label="关闭运行状态提示" onClick={() => setNotice(null)}><X className="h-4 w-4 text-muted-foreground" /></button>
    </div>
  );
}
