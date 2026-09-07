import { useMemoizedFn } from "ahooks";
import { ChevronRight, Copy, RefreshCw } from "lucide-react";
import { useState } from "react";
import type {
  RuntimeStatusCapabilityId,
  RuntimeStatusCapabilitySnapshot,
  RuntimeStatusItem,
  RuntimeStatusState,
} from "@runweave/shared/runtime-status";
import { useRuntimeStatus } from "../features/runtime-status/use-runtime-status";
import { copyRuntimeStatusText } from "../features/runtime-status/copy";
import { useElectronRuntimeStats } from "../features/use-electron-runtime-stats";
import { Button } from "./ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "./ui/sheet";

const CAPABILITY_LABELS: Record<RuntimeStatusCapabilityId, string> = {
  node: "节点连接",
  terminal: "Terminal",
  feishu: "飞书接入",
  "app-server": "App Server",
  "workspace-services": "Workspace Services",
  desktop: "Desktop",
  "background-tasks": "后台任务",
};
const STATE_LABELS: Record<RuntimeStatusState, string> = {
  healthy: "正常", recovering: "恢复中", unhealthy: "异常",
  blocked: "无法判断", checking: "检查中", unconfigured: "未配置",
  disabled: "已停用", unsupported: "版本不支持",
};
const STATE_DOT: Record<RuntimeStatusState, string> = {
  unhealthy: "bg-red-500", recovering: "bg-amber-500",
  checking: "bg-slate-400", blocked: "bg-slate-400",
  healthy: "bg-emerald-500", unconfigured: "bg-slate-400",
  disabled: "bg-slate-400", unsupported: "bg-slate-400",
};

function formatObservedAt(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(value);
}

function RuntimeStatusItemRow({ item }: { item: RuntimeStatusItem }) {
  const copy = useMemoizedFn(async (value: string) => {
    await copyRuntimeStatusText(value);
  });
  return (
    <div
      className="rounded-lg border border-border/60 bg-background/60 p-3"
      data-runtime-status-item={item.id}
      data-runtime-status-state={item.state}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{item.label}</p>
          <p className="mt-1 text-xs text-muted-foreground">{item.summary}</p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className={`h-2 w-2 rounded-full ${STATE_DOT[item.state]}`} />
          {STATE_LABELS[item.state]}
        </span>
      </div>
      {item.recovery ? (
        <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">
          {item.recovery.attempt === null
            ? "正在按 owner 恢复策略重试"
            : `重试 ${item.recovery.attempt}${item.recovery.maxAttempts === null ? "" : ` / ${item.recovery.maxAttempts}`}`}
        </p>
      ) : null}
      {item.dependsOn.length > 0 && item.state === "blocked" ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          上游：{item.dependsOn.join("、")}
        </p>
      ) : null}
      {item.facts.length > 0 ? (
        <div className="mt-2 space-y-1">
          {item.facts.map((fact) => (
            <div key={fact.id} className="flex items-center justify-between gap-3 text-xs">
              <span className="text-muted-foreground">{fact.label}</span>
              <span className="flex min-w-0 items-center gap-1">
                <span className="truncate font-mono">{fact.value}</span>
                {fact.copyable ? (
                  <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`复制${fact.label}`} onClick={() => void copy(fact.value)}>
                    <Copy className="h-3 w-3" />
                  </button>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground/80">
        <span>更新于 {formatObservedAt(item.observedAt)}</span>
        {item.navigation ? (
          <button type="button" className="inline-flex items-center gap-0.5 hover:text-foreground" onClick={() => window.location.assign(item.navigation!.route)}>
            {item.navigation.label}<ChevronRight className="h-3 w-3" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function CapabilitySection({ capability }: { capability: RuntimeStatusCapabilitySnapshot }) {
  const [open, setOpen] = useState(capability.state === "unhealthy");
  return (
    <section className="overflow-hidden rounded-xl border border-border/70" data-runtime-status-capability={capability.capabilityId} data-runtime-status-state={capability.state}>
      <button type="button" className="flex w-full items-center justify-between gap-3 bg-muted/30 px-4 py-3 text-left" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <span className="text-sm font-medium">{CAPABILITY_LABELS[capability.capabilityId]}</span>
        <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
          <span className={`h-2 w-2 rounded-full ${STATE_DOT[capability.state]}`} />
          {STATE_LABELS[capability.state]}
          <ChevronRight className={`h-3.5 w-3.5 transition ${open ? "rotate-90" : ""}`} />
        </span>
      </button>
      {open ? (
        <div className="space-y-2 border-t border-border/60 p-3">
          {capability.items.map((item) => <RuntimeStatusItemRow key={item.id} item={item} />)}
        </div>
      ) : null}
    </section>
  );
}

function RuntimeResources() {
  const { snapshot, error } = useElectronRuntimeStats();
  if (window.electronAPI?.isElectron !== true) return null;
  const cpu = snapshot ? snapshot.electron.totalCpuPercent + (snapshot.backend.cpuPercent ?? 0) : null;
  const memory = snapshot ? snapshot.electron.totalMemoryMb + (snapshot.backend.memoryMb ?? 0) : null;
  return (
    <div className="rounded-xl border border-border/70 p-4">
      <div className="flex items-center justify-between gap-3">
        <div><p className="text-sm font-medium">资源摘要</p><p className="mt-1 text-xs text-muted-foreground">CPU {cpu === null ? "--" : `${cpu.toFixed(1)}%`} · RAM {memory ?? "--"} MB</p></div>
        <Button variant="ghost" size="sm" onClick={() => window.location.assign("/system-monitor")}>System Monitor</Button>
      </div>
      {error ? <p className="mt-2 text-xs text-amber-600">{error}</p> : null}
    </div>
  );
}

export function RuntimeStatusPanel() {
  const { nodes, panelOpen, setPanelOpen, refresh, refreshing } = useRuntimeStatus();
  const copyAddress = useMemoizedFn(async (value: string) => {
    await copyRuntimeStatusText(value);
  });
  return (
    <Sheet open={panelOpen} onOpenChange={setPanelOpen}>
      <SheetContent className="w-[min(92vw,42rem)] overflow-hidden p-0 sm:max-w-[42rem]">
        <SheetHeader className="border-b border-border/70 px-6 py-5 pr-14">
          <div className="flex items-center justify-between gap-4">
            <div><SheetTitle>运行状态</SheetTitle><SheetDescription>当前依赖、恢复状态与最近证据</SheetDescription></div>
            <Button variant="secondary" size="sm" disabled={refreshing} onClick={() => void refresh()}>
              <RefreshCw className={refreshing ? "animate-spin" : ""} />{refreshing ? "检查中" : "重新检查"}
            </Button>
          </div>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-6">
          {nodes.map((node) => (
            <article key={node.id} className="space-y-3 rounded-2xl border border-border/70 bg-card/60 p-4" data-runtime-status-node={node.id}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold">{node.roles.includes("local") ? "本机节点" : "连接节点"}</h2>{node.roles.map((role) => <span key={role} className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">{role === "local" ? "本机" : "当前连接"}</span>)}</div><button type="button" className="mt-1 inline-flex max-w-full items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground" aria-label={`${node.roles.includes("local") ? "复制本机" : "复制当前连接"}地址`} onClick={() => void copyAddress(node.address)}><span className="truncate">{node.address}</span><Copy className="h-3 w-3 shrink-0" /></button></div>
                <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"><span className={`h-2 w-2 rounded-full ${STATE_DOT[node.state]}`} />{STATE_LABELS[node.state]}</span>
              </div>
              <div className="space-y-2">{node.capabilities.map((capability) => <CapabilitySection key={capability.capabilityId} capability={capability} />)}</div>
              {node.roles.includes("local") ? <RuntimeResources /> : null}
            </article>
          ))}
          {nodes.length === 0 ? <p className="py-12 text-center text-sm text-muted-foreground">正在检查运行状态…</p> : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
