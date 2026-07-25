import type { Insight } from "@runweave/shared/evolution";
import { Link } from "react-router-dom";
import { Lightbulb } from "lucide-react";
import { Button } from "../../components/ui/button";
import { EvolutionPanel, formatEvolutionDate } from "./evolution-page-panels";

export function EvolutionInsightsPanel({ insights }: { insights: Insight[] }) {
  return (
    <EvolutionPanel className="overflow-hidden">
      <div className="border-b border-border/70 px-5 py-4">
        <h2 className="font-semibold">长期洞察</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {insights.length} 条稳定语义身份，revision 保留历史
        </p>
      </div>
      {insights.length > 0 ? (
        <div className="divide-y divide-border/60">
          {insights.map((insight) => {
            const current = currentInsightRevision(insight);
            return (
              <article
                key={insight.insightId}
                className="[content-visibility:auto] p-5 [contain-intrinsic-size:auto_180px]"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {insight.topicKey}
                    </p>
                    <h3 className="mt-2 font-medium">
                      {current?.statement ?? "当前 revision 不可用"}
                    </h3>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {current?.scope}
                    </p>
                  </div>
                  {current ? (
                    <span className="rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs">
                      {current.novelty}
                    </span>
                  ) : null}
                </div>
                <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <span>{insight.revisions.length} revisions</span>
                  <span>·</span>
                  <span>{formatEvolutionDate(insight.updatedAt)}</span>
                  {current ? (
                    <>
                      <span>·</span>
                      <span>
                        confidence {Math.round(current.confidence * 100)}%
                      </span>
                    </>
                  ) : null}
                </div>
                {current?.evidenceIds.length ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {current.evidenceIds.slice(0, 6).map((evidenceId) => (
                      <Button
                        key={evidenceId}
                        variant="outline"
                        size="sm"
                        asChild
                      >
                        <Link
                          to={`/activity?view=facts&search=${encodeURIComponent(evidenceId)}`}
                        >
                          {evidenceId}
                        </Link>
                      </Button>
                    ))}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : (
        <div className="flex min-h-[420px] items-center justify-center p-8 text-center">
          <div className="max-w-lg">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <Lightbulb className="h-5 w-5 text-muted-foreground" />
            </div>
            <h2 className="mt-5 text-xl font-semibold">尚无实质新知识</h2>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              只有通过证据和 Novelty Gate 的结论才会出现在这里；页面不使用
              Candidate 或 mock 数据补空状态。
            </p>
          </div>
        </div>
      )}
    </EvolutionPanel>
  );
}

function currentInsightRevision(insight: Insight) {
  return insight.revisions.find(
    (revision) => revision.revisionId === insight.currentRevisionId,
  );
}
