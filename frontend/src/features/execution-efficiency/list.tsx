import type {
  EfficiencyFindingPage,
  EfficiencyMeasurement,
} from "@runweave/shared/execution-efficiency";
import { Button } from "../../components/ui/button";

export function EfficiencyFindingList({
  items,
  onOpen,
}: {
  items: EfficiencyFindingPage["items"];
  onOpen: (findingId: string) => void;
}) {
  if (!items.length) {
    return (
      <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
        当前筛选下没有达到证据门槛的候选
      </div>
    );
  }
  return (
    <div className="grid gap-3">
      {items.map((finding) => (
        <article key={finding.id} className="rounded-xl border bg-card p-4 shadow-sm">
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>{finding.dimension === "duration" ? "执行耗时" : "Token 用量"}</span>
                <span>·</span>
                <span>{statusLabel(finding.status)}</span>
                {finding.hasNewEvidence ? <span className="text-primary">有新证据</span> : null}
              </div>
              <h3 className="mt-1 font-medium">{finding.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                {measurementLabel(finding.measurement)}
              </p>
              <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                {finding.admissionReason}
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => onOpen(finding.id)}>
              查看详情
            </Button>
          </div>
        </article>
      ))}
    </div>
  );
}

export function measurementLabel(measurement: EfficiencyMeasurement): string {
  if (measurement.kind !== "token-windows") {
    return measurement.seconds === null
      ? "耗时未记录"
      : `观测耗时 ${measurement.seconds.toFixed(3)} 秒${measurement.targetSeconds === null ? "" : ` · 目标 ${measurement.targetSeconds} 秒`}`;
  }
  return `相关区间输入 ${number(measurement.input)} · 缓存 ${number(measurement.cachedInput)} · 非缓存 ${number(measurement.nonCachedInput)} · 输出 ${number(measurement.output)}`;
}

function number(value: number | null): string {
  return value === null ? "未记录" : value.toLocaleString("en-US");
}

function statusLabel(status: string): string {
  return {
    pending: "待处理",
    processing: "处理中",
    resolved: "已处理",
    deferred: "暂不处理",
    dismissed: "已排除",
  }[status] ?? status;
}
