import type {
  DevResource,
  DevResourceGroup,
  DevResourceState,
} from "@runweave/shared/dev-resources";
import { ChevronRight, Monitor, Smartphone, AlertTriangle } from "lucide-react";
import { Button } from "../../components/ui/button";

export const stateLabels: Record<DevResourceState, string> = {
  busy: "使用中",
  free: "空闲",
  blocked: "待检查",
  unknown: "未知",
};
const tones: Record<DevResourceState, string> = {
  busy: "text-sky-300 bg-sky-500/10",
  free: "text-slate-400 bg-slate-700/25",
  blocked: "text-amber-300 bg-amber-500/10",
  unknown: "text-amber-300 bg-amber-500/10",
};
export type ResourceFilter = "all" | "attention" | DevResourceState;

export function timeLabel(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function duration(value: string | null, observedAt: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  const minutes = Math.max(
    0,
    Math.floor((Date.parse(observedAt) - Date.parse(value)) / 60000),
  );
  return minutes >= 60
    ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`
    : `${minutes} 分钟`;
}

export function ResourceList({
  title,
  group,
  sessions = [],
  observedAt,
  filter,
  expanded,
  onToggle,
  onRelease,
  pending,
}: {
  title: string;
  group: DevResourceGroup;
  sessions?: DevResource[];
  observedAt: string;
  filter: ResourceFilter;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onRelease: (item: DevResource) => void;
  pending: boolean;
}) {
  const items = [...group.resources, ...sessions].filter(
    (item) =>
      filter === "all" ||
      item.state === filter ||
      (filter === "attention" && ["blocked", "unknown"].includes(item.state)),
  );
  return (
    <section
      aria-label={`${title}资源`}
      className="overflow-hidden rounded-lg border border-slate-800 bg-slate-900/60"
    >
      <header className="flex items-center gap-3 border-b border-slate-800 p-4">
        {title === "桌面测试" ? (
          <Monitor className="h-5 w-5 text-slate-400" />
        ) : (
          <Smartphone className="h-5 w-5 text-slate-400" />
        )}
        <div className="flex-1">
          <h2 className="font-semibold">{title}</h2>
          <p className="mt-1 text-xs text-slate-500">
            {title === "桌面测试" ? "Runweave Beta" : "iOS Simulator"}
          </p>
        </div>
        <span className="text-xs text-slate-400">
          {group.counts.free ?? "—"} 空闲 / {group.counts.total ?? "—"} 总计
        </span>
      </header>
      {group.reason && (
        <p
          role={group.sourceState === "ready" ? "status" : "alert"}
          className="border-b border-slate-800 px-4 py-3 text-sm text-amber-300"
        >
          {group.reason}
        </p>
      )}
      <div className="overflow-x-auto">
        <div className="min-w-[760px]">
          <div className="grid grid-cols-[1.3fr_0.6fr_1.6fr_0.8fr_1fr_24px] gap-4 px-4 py-3 text-xs text-slate-500">
            <span>资源</span>
            <span>状态</span>
            <span>占用任务 / 工作树</span>
            <span>占用时长</span>
            <span>最后活动</span>
            <span />
          </div>
          {items.map((item) => (
            <div
              key={item.id}
              data-resource-id={item.id}
              className="border-t border-slate-800"
            >
              <button
                type="button"
                className="grid w-full grid-cols-[1.3fr_0.6fr_1.6fr_0.8fr_1fr_24px] items-center gap-4 px-4 py-4 text-left hover:bg-slate-800/50"
                aria-label={`${item.label}详情`}
                aria-expanded={expanded.has(item.id)}
                onClick={() => onToggle(item.id)}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm">{item.label}</span>
                  <span className="mt-1 block truncate text-xs text-slate-500">
                    {item.kind === "desktop-session"
                      ? "非池 Session · 不计入槽位容量"
                      : (item.details.deviceState ?? item.id)}
                  </span>
                </span>
                <span>
                  <span
                    className={`rounded px-2 py-1 text-xs ${tones[item.state]}`}
                  >
                    {stateLabels[item.state]}
                  </span>
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm">
                    {item.owner?.task ??
                      (item.state === "free"
                        ? "没有占用任务"
                        : (item.owner?.id ?? "占用者未知"))}
                  </span>
                  <span className="mt-1 block truncate text-xs text-slate-500">
                    {item.owner?.worktree}
                  </span>
                </span>
                <span className="text-xs text-slate-400">
                  {duration(item.owner?.startedAt ?? null, observedAt)}
                </span>
                <span className="text-xs text-slate-400">
                  {timeLabel(item.owner?.lastActivityAt ?? null)}
                </span>
                <ChevronRight
                  className={`h-4 w-4 text-slate-500 ${expanded.has(item.id) ? "rotate-90" : ""}`}
                />
              </button>
              {expanded.has(item.id) && (
                <div className="space-y-4 bg-slate-950/50 p-4">
                  {(item.reason || item.operation) && (
                    <p className="flex items-start gap-2 rounded border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-300">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      {item.operation?.state === "running"
                        ? "正在释放，请稍后手动刷新"
                        : (item.reason ?? "上次操作结果尚未确认")}
                    </p>
                  )}
                  <div className="grid gap-6 lg:grid-cols-2">
                    <dl className="space-y-2 text-xs">
                      {[
                        ["占用者", item.owner?.id],
                        ["工作目录", item.details.path],
                        ["占用开始", timeLabel(item.owner?.startedAt ?? null)],
                        ["端口", item.details.ports.join(" · ")],
                        ["设备 UDID", item.details.udid],
                      ]
                        .filter(
                          ([label]) =>
                            label !== "设备 UDID" || item.kind === "simulator",
                        )
                        .map(([label, value]) => (
                          <div
                            key={label}
                            className="grid grid-cols-[80px_1fr] gap-2"
                          >
                            <dt className="text-slate-500">{label}</dt>
                            <dd className="break-all font-mono text-slate-300">
                              {value || "—"}
                            </dd>
                          </div>
                        ))}
                    </dl>
                    <div>
                      <p className="mb-2 text-xs text-slate-500">当前进程</p>
                      {item.details.processes.length ? (
                        <ul className="space-y-2 text-xs">
                          {item.details.processes.map((process) => (
                            <li
                              key={process.pid}
                              className="flex justify-between gap-3"
                            >
                              <span>
                                {process.name} · {process.pid}
                                {process.ownership === "shared"
                                  ? " · 共享"
                                  : process.ownership === "unknown"
                                    ? " · 身份未知"
                                    : ""}
                              </span>
                              <span className="text-slate-400">
                                {process.cpuPercent === null
                                  ? "CPU —"
                                  : `CPU ${process.cpuPercent.toFixed(1)}%`}{" "}
                                ·{" "}
                                {process.rssBytes === null
                                  ? "内存 —"
                                  : `${Math.round(process.rssBytes / 1048576)} MB`}
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-xs text-slate-400">
                          {item.state === "unknown"
                            ? "进程状态未知"
                            : "未发现存活的测试进程"}
                        </p>
                      )}
                    </div>
                  </div>
                  {item.state !== "free" && (
                    <div className="flex items-center justify-between gap-4 border-t border-slate-800 pt-4">
                      <p className="text-xs text-slate-400">
                        {item.release.disabledReason ??
                          (item.release.action === "stop-and-release"
                            ? "将停止当前测试并释放该资源"
                            : "核对归属后清理残留占用")}
                      </p>
                      <Button
                        size="sm"
                        variant={
                          item.release.action === "stop-and-release"
                            ? "destructive"
                            : "outline"
                        }
                        disabled={pending || !item.release.action}
                        onClick={() => onRelease(item)}
                      >
                        {item.release.action === "stop-and-release"
                          ? "停止并释放"
                          : item.release.action === "release-occupancy"
                            ? "释放占用"
                            : "无法释放"}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          {!items.length && (
            <p className="p-8 text-center text-sm text-slate-500">
              {group.sourceState === "unavailable" ||
              group.sourceState === "unsupported"
                ? "当前资源状态未知"
                : "没有符合条件的资源"}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
