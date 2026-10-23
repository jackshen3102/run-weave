import type { AgentProviderCatalog } from "@runweave/shared/agent-model-catalog";
import type { PublicConfigurationField } from "@runweave/shared/configuration";
import { Button } from "../../components/ui/button";
import { ModelEffortPicker, effortLabel } from "../agent-models/model-effort-picker";

export function ConfigurationModelSetting({ field, model, effort, defaultEffort, catalog, loading, disabled, onRetry, onChange }: {
  field: PublicConfigurationField;
  model: string;
  effort: string;
  defaultEffort: string;
  catalog?: AgentProviderCatalog;
  loading: boolean;
  disabled: boolean;
  onRetry: () => void;
  onChange: (model: string | null, effort: string | null) => void;
}) {
  const selection = field.modelSelection!;
  const models = (catalog?.availability === "available" ? catalog.models : []).map(item => ({
    ...item, reasoningEfforts: item.reasoningEfforts.filter(value => !selection.allowedEfforts || selection.allowedEfforts.includes(value)),
  }));
  const defaultModel = "value" in field.default ? field.default.value : null;
  const effectiveModel = model || (typeof defaultModel === "string" ? defaultModel : "");
  const effectiveEffort = effort || defaultEffort;
  const selected = models.find(item => item.id === effectiveModel);
  const summary = `${selected?.label ?? (effectiveModel || "未选择模型")} · ${effectiveEffort ? effortLabel(effectiveEffort) : "模型默认强度"}`;
  return <div className="flex flex-col gap-2">
    <ModelEffortPicker models={models} model={effectiveModel} effort={effectiveEffort} summary={summary} label={selection.label} disabled={disabled || !models.length || loading} allowDefaultEffort={selection.allowDefaultEffort} onChange={onChange} />
    {loading ? <p role="status" className="text-xs text-muted-foreground">正在加载模型…</p> : !models.length ? <div role="status" className="text-xs text-muted-foreground">模型目录暂不可用，已有配置仍会保留。<Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onRetry}>重试</Button></div> : <>
      {catalog?.source === "cache" && <p className="text-xs text-muted-foreground">正在使用此电脑缓存的模型目录。<Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onRetry}>刷新</Button></p>}
      {model && (!selected || effort && !selected.reasoningEfforts.includes(effort)) && <p role="status" className="text-xs text-muted-foreground">已保存的模型或推理强度不在当前目录中，保留原值；可重新选择。</p>}
    </>}
    <Button type="button" variant="ghost" size="sm" className="self-start" disabled={disabled} onClick={() => onChange(null, null)}>恢复默认</Button>
  </div>;
}
