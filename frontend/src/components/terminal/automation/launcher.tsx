import { useEffect, useState } from "react";
import { useMemoizedFn } from "ahooks";
import { Activity, ExternalLink } from "lucide-react";
import { Button } from "../../ui/button";

/** The former browser-only sidebar is now the entry to the unified observer. */
export function AgentObserverLauncher({ active }: { active: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const open = useMemoizedFn(async () => {
    try {
      if (!window.electronAPI?.openAgentObserver) throw new Error("当前客户端不支持观察窗口");
      await window.electronAPI.openAgentObserver();
      setError(null);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "无法打开观察窗口"); }
  });
  useEffect(() => { if (active) void open(); }, [active, open]);
  return <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
    <Activity className="h-8 w-8 text-slate-500" />
    <h2 className="text-sm font-medium text-slate-100">Agent 实时观察</h2>
    <p className="max-w-xs text-xs text-slate-400">浏览器、模拟器和其他窗口统一在独立观察窗中展示，可放到第二块屏幕。</p>
    <Button size="sm" variant="outline" onClick={() => void open()}><ExternalLink className="mr-2 h-3 w-3" />打开观察窗口</Button>
    {error && <p role="alert" className="text-xs text-rose-400">{error}</p>}
  </div>;
}
