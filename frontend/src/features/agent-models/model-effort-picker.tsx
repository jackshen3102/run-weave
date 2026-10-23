import { useState } from "react";
import { ArrowLeft, Check, ChevronRight, ChevronsUpDown } from "lucide-react";
import type { AgentCatalogModel } from "@runweave/shared/agent-model-catalog";
import { Button } from "../../components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";

export function effortLabel(effort: string) {
  return ({ minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "很高", max: "最大", ultra: "极限" } as Record<string, string>)[effort] ?? effort;
}

/** Only commits a pair after the effort is chosen; back/close leave the draft alone. */
export function ModelEffortPicker({ models, model, effort, summary, label, disabled, allowDefaultEffort = false, onChange }: {
  models: AgentCatalogModel[];
  model: string;
  effort: string;
  summary: string;
  label: string;
  disabled?: boolean;
  allowDefaultEffort?: boolean;
  onChange: (model: string, effort: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [selectedID, setSelectedID] = useState<string | null>(null);
  const selected = models.find(item => item.id === selectedID);
  const choose = (value: string) => {
    if (!selected) return;
    onChange(selected.id, value);
    setOpen(false);
  };
  return <Popover open={open} onOpenChange={value => { setOpen(value); setSelectedID(null); }}>
    <PopoverTrigger asChild>
      <Button type="button" variant="outline" disabled={disabled} aria-label={`${label}：${summary}`} className="w-full justify-between">
        <span className="truncate">{summary}</span><ChevronsUpDown data-icon="inline-end" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)]" aria-label={selected ? "选择推理强度" : "选择模型版本"}>
      <div className="flex items-center gap-2 px-2 py-1">
        {selected && <Button type="button" variant="ghost" size="icon" aria-label="返回模型列表" onClick={() => setSelectedID(null)}><ArrowLeft /></Button>}
        <span className="text-sm font-medium">{selected ? `${selected.label} · 推理强度` : "选择模型版本"}</span>
      </div>
      <div className="flex max-h-72 flex-col gap-1 overflow-y-auto" key={selectedID ?? "models"}>
        {selected ? <>
          {allowDefaultEffort && <Button type="button" variant="ghost" className="justify-between" onClick={() => choose("")}>模型默认强度{model === selected.id && !effort && <Check />}</Button>}
          {selected.reasoningEfforts.map(value => <Button type="button" key={value} variant="ghost" className="justify-between" aria-pressed={model === selected.id && effort === value} onClick={() => choose(value)}>
            <span>{effortLabel(value)} · {value}{value === selected.defaultReasoningEffort ? "（模型默认）" : ""}</span>
            {model === selected.id && effort === value && <Check />}
          </Button>)}
          {!selected.reasoningEfforts.length && !allowDefaultEffort && <p className="p-2 text-sm text-muted-foreground">此模型暂无可选推理强度</p>}
        </> : models.map(item => <Button type="button" key={item.id} variant="ghost" className="h-auto justify-between py-2" onClick={() => setSelectedID(item.id)}>
          <span className="flex min-w-0 flex-col items-start gap-1"><span className="truncate">{item.label}</span><span className="truncate text-xs text-muted-foreground">{item.id}</span></span>
          {model === item.id ? <Check /> : <ChevronRight />}
        </Button>)}
      </div>
    </PopoverContent>
  </Popover>;
}
