import { Check } from "lucide-react";
import type { CreateScheduledTaskRequest } from "@runweave/shared/scheduled-tasks";
import { Button } from "../../components/ui/button";
import { useScheduledModelSettings } from "./queries";

export function TaskModelSettings({
  provider,
  model,
  effort,
  onChange,
}: {
  provider: CreateScheduledTaskRequest["provider"];
  model: string;
  effort: string;
  onChange: (model: string, effort: string) => void;
}) {
  const settings = useScheduledModelSettings();
  const catalog =
    provider === "pi"
      ? undefined
      : settings.data?.catalogs[provider === "trae" ? "traex" : provider];
  const available = catalog?.availability === "available";
  const models = available ? catalog.models : [];
  const selected = models.find((item) => item.id === model);
  return (
    <section className="grid gap-3 rounded-lg border p-3" aria-label="模型配置">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span>模型</span>
        <span className="text-xs text-muted-foreground">
          当前：{selected?.label ?? (model || "Agent 默认配置")}
        </span>
      </div>
      <Button
        type="button"
        variant={!model ? "secondary" : "outline"}
        aria-pressed={!model && !effort}
        onClick={() => onChange("", "")}
      >
        Agent 默认配置
      </Button>
      {settings.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          正在加载模型…
        </p>
      ) : settings.isError || !available ? (
        <div role="status" className="text-sm text-muted-foreground">
          模型目录暂不可用，已有配置仍会保留。
          <Button
            type="button"
            variant="ghost"
            disabled={settings.isFetching}
            onClick={() => void settings.refetch()}
          >
            重试
          </Button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border">
          <div className="max-h-48 overflow-y-auto p-1.5" aria-label="可用模型">
            {models.map((item) => (
              <button
                type="button"
                key={item.id}
                aria-pressed={model === item.id}
                className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-accent aria-pressed:bg-accent"
                onClick={() =>
                  onChange(item.id, item.defaultReasoningEffort ?? "")
                }
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {item.label}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {item.id}
                  </span>
                </span>
                {model === item.id ? (
                  <Check className="h-4 w-4 shrink-0" />
                ) : null}
              </button>
            ))}
            {!models.length ? (
              <p className="p-3 text-sm text-muted-foreground">暂无可用模型</p>
            ) : null}
          </div>
        </div>
      )}
      <div className="grid gap-2" role="group" aria-label="推理强度">
        <span className="text-sm">推理强度</span>
        {selected?.reasoningEfforts.length ? (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant={!effort ? "secondary" : "outline"}
              aria-pressed={!effort}
              onClick={() => onChange(model, "")}
            >
              Agent 默认配置
            </Button>
            {selected.reasoningEfforts.map((value) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={effort === value ? "secondary" : "outline"}
                aria-pressed={effort === value}
                onClick={() => onChange(model, value)}
              >
                {value}
              </Button>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {selected
              ? "此模型不提供可配置档位"
              : "选择模型后可设置其支持的推理强度"}
          </p>
        )}
        {effort && !selected?.reasoningEfforts.includes(effort) ? (
          <p role="status" className="text-xs text-muted-foreground">
            已保存推理强度：{effort}（当前无法验证）。
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange(model, "")}
            >
              重置推理强度
            </Button>
          </p>
        ) : null}
      </div>
      {available && model && !selected ? (
        <p role="status" className="text-xs text-muted-foreground">
          已保存模型 {model} 不在当前目录中，可重新选择。
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        模型列表来自当前连接的 CLI；配置仅对本任务生效。
      </p>
    </section>
  );
}
