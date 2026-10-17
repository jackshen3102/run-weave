import { runtimeServiceInventory } from "@runweave/shared/service-management";
import type { RuntimeStatusReport, RuntimeStatusState } from "@runweave/shared/runtime-status";

const labels: Record<RuntimeStatusState, string> = { healthy: "正常", unhealthy: "异常", blocked: "无法判断", recovering: "恢复中", checking: "检查中", disabled: "已停用", unconfigured: "未配置 / 未上报", unsupported: "未上报 / 需更新" };

export function RuntimeServices({ reports }: { reports: RuntimeStatusReport[] }) {
  const services = runtimeServiceInventory(reports);
  const unconfirmed = services.filter(service => ["unsupported", "unconfigured", "blocked", "checking"].includes(service.state)).length;
  const restart = services.filter(service => service.installation === "restart-required").length;
  return <section className="rounded-xl border border-border/70 p-4" aria-label="本机服务清单">
    <h3 className="text-sm font-medium">服务清单 · {services.length} 项</h3>
    <p className="mt-1 text-xs text-muted-foreground">此节点所属实例的服务与本机共享 Host；云端和其他实例分别检查。{unconfirmed > 0 ? ` ${unconfirmed} 项未确认。` : ""}{restart > 0 ? ` ${restart} 项需要重启。` : ""}</p>
    <div className="mt-3 divide-y divide-border/50">
      {services.map(service => <details key={service.id} className="py-2" data-runtime-service={service.id} data-runtime-installation={service.installation}>
        <summary className="flex cursor-pointer items-center justify-between gap-3 text-xs">
          <span className="font-medium">{service.label}</span>
          <span className={service.state === "unhealthy" ? "text-red-600" : service.installation === "restart-required" || ["unsupported", "unconfigured", "blocked", "recovering"].includes(service.state) ? "text-amber-600" : "text-muted-foreground"}>
            {labels[service.state]}{service.installation === "restart-required" ? " · 需要重启" : ""}
          </span>
        </summary>
        <p className="mt-2 text-xs text-muted-foreground">{service.summary}</p>
        <p className="mt-1 text-xs text-muted-foreground">运行版本：{service.version ?? "未上报"} · 安装对照：{service.installation === "current" ? "运行产物与安装产物一致" : service.installation === "restart-required" ? "已安装产物尚未生效，请使用该服务的更新或重启入口" : "无法确认；缺少可对照的安装或运行身份"}</p>
        {service.observedAt !== null ? <p className="mt-1 text-[11px] text-muted-foreground">最近证据：{new Date(service.observedAt).toLocaleString()}</p> : null}
      </details>)}
    </div>
    <p className="mt-2 text-[11px] text-muted-foreground">安装一致不代表已包含最新源码；未上报和历史成功不代表当前正常。检查不会自动更新或重启服务。</p>
  </section>;
}
