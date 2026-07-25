import { createHash } from "node:crypto";
import type {
  CandidateAsset,
  ContributionEdge,
  InsightRevision,
} from "@runweave/shared/evolution";
import type { ActivityQueryService } from "../../activity/query-service";
import type {
  EvolutionAnalysisStore,
  EvolutionPreparedInsightRevision,
} from "../analysis-store";
import { evaluateEvidenceAvailabilityDrift } from "./lifecycle";

const ACTIVITY_EVIDENCE_PREFIX = "activity:";
const AVAILABILITY_BATCH_SIZE = 1_000;

export interface EvolutionEvidenceReconciliationResult {
  inspectedInsights: number;
  revisedInsights: number;
  revisedCandidates: number;
}

export class EvolutionEvidenceReconciler {
  constructor(
    private readonly activity: ActivityQueryService,
    private readonly store: EvolutionAnalysisStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async reconcile(): Promise<EvolutionEvidenceReconciliationResult> {
    const dependencies = await this.store.listEvidenceDependencies();
    const eventIds = [
      ...new Set(
        dependencies.flatMap((dependency) =>
          dependency.contributionEdges.flatMap((edge) =>
            edge.evidenceId.startsWith(ACTIVITY_EVIDENCE_PREFIX)
              ? [edge.evidenceId.slice(ACTIVITY_EVIDENCE_PREFIX.length)]
              : [],
          ),
        ),
      ),
    ];
    const availabilityByEvidenceId = new Map<
      string,
      { availability: "available" | "unavailable"; reason: string }
    >();
    for (
      let index = 0;
      index < eventIds.length;
      index += AVAILABILITY_BATCH_SIZE
    ) {
      const batch = eventIds.slice(index, index + AVAILABILITY_BATCH_SIZE);
      const statuses = await this.activity.evolutionEvidenceAvailability(batch);
      for (const status of statuses) {
        availabilityByEvidenceId.set(
          `${ACTIVITY_EVIDENCE_PREFIX}${status.eventId}`,
          {
            availability: status.availability,
            reason: status.reason,
          },
        );
      }
    }

    const reconciledInsights: EvolutionPreparedInsightRevision[] = [];
    const reconciledCandidates: CandidateAsset[] = [];
    const createdAt = this.now().toISOString();
    for (const dependency of dependencies) {
      const nextEdges = dependency.contributionEdges.map((edge) => {
        const current = availabilityByEvidenceId.get(edge.evidenceId);
        const availability =
          edge.availability === "unavailable"
            ? "unavailable"
            : (current?.availability ?? edge.availability);
        return { ...edge, availability };
      });
      if (
        nextEdges.every(
          (edge, index) =>
            edge.availability ===
            dependency.contributionEdges[index]?.availability,
        )
      ) {
        continue;
      }
      const unavailableReasons = nextEdges.flatMap((edge) => {
        if (edge.availability !== "unavailable") return [];
        const status = availabilityByEvidenceId.get(edge.evidenceId);
        return [`${edge.evidenceId}:${status?.reason ?? "unavailable"}`];
      });
      const reason = `evidence_unavailable:${unavailableReasons.join(",")}`;
      const revision = reconciledRevision(
        dependency.revision,
        nextEdges,
        createdAt,
      );
      const insight = {
        ...dependency.insight,
        currentRevisionId: revision.revisionId,
        updatedAt: createdAt,
      };
      reconciledInsights.push({
        insight,
        revision,
        contributionEdges: nextEdges.map((edge) => ({
          ...edge,
          edgeId: stableId("edge", [
            revision.revisionId,
            edge.evidenceId,
            edge.relation,
          ]),
          insightRevisionId: revision.revisionId,
          createdAt,
        })),
      });
      const supportEdges = nextEdges.filter(
        (edge) => edge.relation === "supports",
      );
      const allSupportingEvidenceUnavailable =
        supportEdges.length > 0 &&
        supportEdges.every((edge) => edge.availability === "unavailable");
      for (const candidate of dependency.candidates) {
        const decision = evaluateEvidenceAvailabilityDrift(
          candidate,
          {
            insightRevisionId: revision.revisionId,
            allSupportingEvidenceUnavailable,
            reason,
          },
          createdAt,
        );
        if (decision.changed) reconciledCandidates.push(decision.candidate);
      }
    }
    if (reconciledInsights.length > 0) {
      await this.store.applyEvidenceReconciliation({
        insights: reconciledInsights,
        candidates: reconciledCandidates,
      });
    }
    return {
      inspectedInsights: dependencies.length,
      revisedInsights: reconciledInsights.length,
      revisedCandidates: reconciledCandidates.length,
    };
  }
}

function reconciledRevision(
  current: InsightRevision,
  edges: ContributionEdge[],
  createdAt: string,
): InsightRevision {
  const supporting = edges.filter((edge) => edge.relation === "supports");
  const availableSupporting = supporting.filter(
    (edge) => edge.availability === "available",
  );
  const availabilityRatio =
    supporting.length === 0
      ? 1
      : availableSupporting.length / supporting.length;
  return {
    ...current,
    revisionId: stableId("irev", [
      current.revisionId,
      ...edges.map(
        (edge) =>
          `${edge.evidenceId}:${edge.relation}:${edge.availability}`,
      ),
    ]),
    confidence: Math.round(
      Math.min(current.confidence, current.confidence * availabilityRatio) *
        100,
    ) / 100,
    createdAt,
  };
}

function stableId(prefix: string, values: string[]): string {
  return `${prefix}_${createHash("sha256")
    .update(values.join("\n"))
    .digest("hex")
    .slice(0, 24)}`;
}
