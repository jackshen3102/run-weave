import type {
  CandidateAsset,
  EvolutionRepository,
  Insight,
} from "@runweave/shared/evolution";
import type { EvolutionAnalysisStore } from "../evolution/analysis-store";
import type { EvolutionFoundationStore } from "../evolution/foundation-store";
import type { ActivityQueryService } from "../activity/database/service";
import {
  contentVersion,
  digest,
  itemId,
  normalize,
  publicContent,
  publicText,
} from "./projection";
import type { InboxSourceReader, PublishedItem } from "./types";

function belongs(
  value: Pick<Insight, "repositoryId" | "learningScopeId" | "attribution">,
  repositoryId: string,
) {
  return (
    (value.repositoryId ?? value.learningScopeId) === repositoryId &&
    (!value.attribution ||
      (value.attribution.resolution === "resolved" &&
        value.attribution.repositoryIds.length === 1 &&
        value.attribution.repositoryIds[0] === repositoryId))
  );
}
function usable(candidate: CandidateAsset, repositoryId: string) {
  return (
    belongs(candidate, repositoryId) &&
    !["retired", "rejected", "needs_revalidation"].includes(
      candidate.lifecycle,
    ) &&
    Date.parse(candidate.validFrom) <= Date.now() &&
    (!candidate.expiresAt || Date.parse(candidate.expiresAt) > Date.now())
  );
}
export class EvolutionInboxSource implements InboxSourceReader {
  readonly source = "evolution";
  constructor(
    private readonly analysis: EvolutionAnalysisStore | null,
    private readonly foundation: EvolutionFoundationStore | null,
    private readonly activity: ActivityQueryService,
  ) {}
  async read(repositories: EvolutionRepository[]): Promise<PublishedItem[]> {
    if (!this.analysis || !this.foundation)
      throw new Error("evolution_unavailable");
    const analysis = this.analysis;
    const foundation = this.foundation;
    const [insights, dependencies] = await Promise.all([
      analysis.listInsights(),
      analysis.listEvidenceDependencies(),
    ]);
    const allowed = new Map(
      repositories
        .filter((repo) => repo.available)
        .map((repo) => [repo.repositoryId, repo]),
    );
    const result: PublishedItem[] = [];
    for (const insight of insights) {
      const repository = allowed.get(
        insight.repositoryId ?? insight.learningScopeId,
      );
      if (!repository || !belongs(insight, repository.repositoryId)) continue;
      if (
        insight.lineage &&
        (insight.lineage.status !== "resolved" ||
          insight.lineage.canonicalInsightId !== insight.insightId)
      )
        continue;
      const revision = insight.revisions.find(
        (item) => item.revisionId === insight.currentRevisionId,
      );
      const dependency = dependencies.find(
        (item) => item.revision.revisionId === insight.currentRevisionId,
      );
      if (!revision || !dependency || !normalize(revision.statement)) continue;
      const [run, claims] = await Promise.all([
        foundation.getRun(revision.runId),
        analysis.listClaims(revision.runId),
      ]);
      if (
        !run ||
        !["completed", "no_material_novelty"].includes(run.stage) ||
        !["completed", "no_material_novelty"].includes(run.outcome ?? "")
      )
        continue;
      const supportingClaims = claims.filter((claim) =>
        revision.claimIds.includes(claim.claimId),
      );
      if (
        !supportingClaims.length ||
        supportingClaims.some(
          (claim) =>
            claim.status === "contested" || claim.status === "rejected",
        )
      )
        continue;
      const supports = dependency.contributionEdges.filter(
        (edge) =>
          edge.relation === "supports" &&
          edge.availability === "available" &&
          supportingClaims.some((claim) =>
            claim.supportingEvidenceIds.includes(edge.evidenceId),
          ),
      );
      const activityIds = supports.flatMap((edge) =>
        edge.evidenceId.startsWith("activity:")
          ? [edge.evidenceId.slice(9)]
          : [],
      );
      const live = new Map<string, string>();
      for (let i = 0; i < activityIds.length; i += 1000) {
        for (const status of await this.activity.evolutionEvidenceAvailability(
          activityIds.slice(i, i + 1000),
        )) {
          live.set(status.eventId, status.availability);
        }
      }
      if (
        !supports.some(
          (edge) =>
            !edge.evidenceId.startsWith("activity:") ||
            live.get(edge.evidenceId.slice(9)) === "available",
        )
      )
        continue;
      const candidates = dependency.candidates
        .filter(
          (candidate) =>
            candidate.insightRevisionId === revision.revisionId &&
            usable(candidate, repository.repositoryId),
        )
        .sort((a, b) => a.assetId.localeCompare(b.assetId));
      const content = publicContent({
        statement: revision.statement,
        applicability: [
          revision.scope,
          ...candidates.flatMap((candidate) => {
            const conditions = describeConditions({
              ...candidate.applicability,
            });
            return conditions ? [`${candidate.guidance}：${conditions}`] : [];
          }),
        ].join("\n"),
        avoid: candidates
          .map((candidate) => describeConditions({ ...candidate.exclusions }))
          .filter(Boolean),
        guidance: candidates
          .map((candidate) => candidate.guidance)
          .filter(Boolean),
      });
      // Maintenance revisions preserve the first date carrying the same business body.
      const first = insight.revisions
        .filter(
          (item) =>
            normalize(item.statement) === normalize(revision.statement) &&
            normalize(item.scope) === normalize(revision.scope),
        )
        .map((item) => item.createdAt)
        .sort()[0]!;
      const dates = [
        first,
        ...candidates.map((candidate) => candidate.createdAt),
      ].sort();
      result.push({
        ...content,
        itemId: itemId(this.source, repository.repositoryId, insight.insightId),
        repositoryId: repository.repositoryId,
        projectName: publicText(repository.name),
        source: this.source,
        sourceId: insight.insightId,
        sourceRevision: digest(
          JSON.stringify([
            revision.revisionId,
            candidates.map((candidate) => candidate.revisionId),
          ]),
        ),
        kind: candidates.length ? "suggestion" : "finding",
        title: publicText(insight.topicKey),
        validationLabel:
          candidates.length ||
          supportingClaims.some((claim) => claim.status !== "corroborated")
            ? "待验证·使用前核对适用条件"
            : "洞察·使用前核对适用条件",
        contentVersion: contentVersion(content),
        contentUpdatedAt: dates.at(-1)!,
      });
    }
    return result;
  }
}

function describeConditions(
  conditions: Record<string, string[] | undefined>,
): string {
  const labels: Record<string, string> = {
    workerRoles: "角色",
    taskTerms: "任务",
    pathPrefixes: "路径范围",
    commandTerms: "命令",
    failureSignatures: "故障特征",
  };
  return Object.keys(labels)
    .flatMap((key) =>
      conditions[key]?.length
        ? [`${labels[key]}：${conditions[key]!.join("、")}`]
        : [],
    )
    .join("；");
}
