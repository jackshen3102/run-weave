import { ArrowLeft, ExternalLink } from "lucide-react";
import { Button } from "../../components/ui/button";
import { useEfficiencyFinding } from "./queries";
import { measurementLabel } from "./list";
import { EfficiencyFindingActions } from "./actions";

export function EfficiencyFindingDetailView({
  findingId,
  onBack,
  onOpenTask,
}: {
  findingId: string;
  onBack: () => void;
  onOpenTask: (taskId: string) => void;
}) {
  const query = useEfficiencyFinding(findingId);
  if (query.isPending) return <p>正在加载候选详情…</p>;
  if (query.error)
    return (
      <p role="alert" className="text-sm text-destructive">
        {String(query.error)}
      </p>
    );
  const finding = query.data;
  if (!finding) return null;
  return (
    <div className="space-y-5">
      <Button variant="ghost" onClick={onBack}>
        <ArrowLeft className="h-4 w-4" />
        返回候选列表
      </Button>
      <section className="rounded-xl border bg-card p-5">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground">
              {finding.dimension === "duration" ? "执行耗时" : "Token 用量"} ·
              revision {finding.revision}
            </p>
            <h1 className="mt-1 text-xl font-semibold">{finding.title}</h1>
          </div>
          {finding.source.taskId ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenTask(finding.source.taskId!)}
            >
              <ExternalLink className="h-4 w-4" />
              来源任务
            </Button>
          ) : null}
        </div>
        <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2">
          <DetailTerm
            label="观测值"
            value={measurementLabel(
              finding.observations.at(-1)?.measurement ??
                fallbackMeasurement(finding.dimension),
            )}
          />
          <DetailTerm label="入列依据" value={finding.admissionReason} />
          <DetailTerm label="优化假设" value={finding.hypothesis} />
          <DetailTerm label="不确定性" value={finding.uncertainty} />
          <DetailTerm label="验证方向" value={finding.verification} />
          <DetailTerm
            label="原因标签"
            value={finding.causeTags.join("、") || "未知"}
          />
        </dl>
      </section>
      <section className="space-y-3 rounded-xl border p-4">
        <h2 className="font-semibold">测量与有限证据</h2>
        {finding.observations.map((observation) => (
          <article
            key={observation.id}
            className="rounded-lg bg-muted/50 p-3 text-sm"
          >
            <p>{measurementLabel(observation.measurement)}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {observation.sourceSpan.sessionFile}:
              {observation.sourceSpan.startLine} ·{" "}
              {observation.quality.completeness}
            </p>
            <details className="mt-3">
              <summary className="cursor-pointer select-none text-xs font-medium">
                展开证据
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-3 text-xs">
                {observation.sourceSpan.excerpt}
              </pre>
            </details>
          </article>
        ))}
      </section>
      <EfficiencyFindingActions key={finding.revision} finding={finding} />
      <section className="space-y-2 rounded-xl border p-4">
        <h2 className="font-semibold">处理历史</h2>
        {finding.events.length ? (
          finding.events.map((event) => (
            <div key={event.id} className="border-l-2 pl-3 text-sm">
              <p>{event.note}</p>
              {event.verification ? (
                <p className="mt-1 text-muted-foreground">
                  验证：{event.verification}
                </p>
              ) : null}
              <p className="mt-1 text-xs text-muted-foreground">
                {event.action} · {new Date(event.createdAt).toLocaleString()}
              </p>
            </div>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">暂无人工处理记录</p>
        )}
      </section>
    </div>
  );
}

function DetailTerm({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 whitespace-pre-wrap">{value}</dd>
    </div>
  );
}

function fallbackMeasurement(dimension: "duration" | "tokens") {
  return dimension === "tokens"
    ? {
        kind: "token-windows" as const,
        samples: 0,
        occurrences: 0,
        input: null,
        cachedInput: null,
        nonCachedInput: null,
        cacheWriteInput: null,
        output: null,
        reasoningOutput: null,
        total: null,
        model: null,
        serviceTier: null,
        boundary: "测量不可用",
        callIds: [],
        attribution: "mixed" as const,
      }
    : {
        kind: "call-interval" as const,
        seconds: null,
        targetSeconds: null,
        sampleCount: 0,
        boundary: "测量不可用",
        intervalCount: 0,
        percentile95Seconds: null,
      };
}
