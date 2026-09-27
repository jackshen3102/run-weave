import type { ConfigurationFieldStatus, ConfigurationValueResolution, PublicConfigurationField } from "@runweave/shared/configuration";

const sources = { saved: "已保存的配置", default: "默认值", consumerDefault: "由功能模块决定", unset: "未设置", invalid: "配置无效" };

function describeValue(resolution: ConfigurationValueResolution, sensitive: boolean): string {
  if (resolution.source === "invalid" || resolution.source === "consumerDefault" || resolution.source === "unset") return sources[resolution.source];
  if (sensitive) {
    const value = resolution.value;
    return value && typeof value === "object" && !Array.isArray(value) && value.configured === true ? "已配置（内容隐藏）" : "未配置";
  }
  return `${JSON.stringify(resolution.value) ?? "未设置"} · ${sources[resolution.source]}`;
}

export function ConfigurationFieldDetails({ field, status, changed }: { field: PublicConfigurationField; status: ConfigurationFieldStatus; changed: boolean }) {
  const state = status.state === "applied" ? "当前进程已采用"
    : status.state === "pending" ? field.apply === "restart" ? "已保存，等待所属服务重启" : "已保存，等待所属功能重新加载"
    : status.state === "error" ? "配置或应用失败" : "尚未确认所属服务是否采用";
  return <div className="space-y-1 break-words text-xs text-muted-foreground">
    <p>{state}</p>
    <p>已保存配置的取值：{describeValue(status.saved, field.sensitive)}</p>
    {status.applied && <p>当前进程采用值：{describeValue(status.applied, field.sensitive)}{status.appliedRevision !== null ? ` · 版本 ${status.appliedRevision}` : ""}</p>}
    {status.saved.source === "consumerDefault" && "rule" in field.default && <p>{field.default.rule}</p>}
    {changed && <p>有未保存的修改；以上为上次读取的结果。</p>}
  </div>;
}
