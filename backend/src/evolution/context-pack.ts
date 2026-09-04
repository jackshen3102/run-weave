import {
  ACTIVITY_EVENT_NAMES,
  type ActivityContentDescriptorDto,
  type ActivityEventName,
  type ActivityFactDto,
} from "@runweave/shared/activity";
import {
  resolveEvolutionLearningScope,
  type AnalysisProfile,
  type ContextPackContentRef,
  type ContextPackEvidenceRef,
  type ContextPackManifest,
  type DataQualityIssue,
  type SourceBoundary,
} from "@runweave/shared/evolution";
import { canonicalJson, sha256 } from "../activity/security/canonical";
import type { ActivityQueryService } from "../activity/database/service";
import type { EvolutionContextPackStore } from "./context-pack-store";
import type { EvolutionSupplementalSourceReader } from "./supplemental-sources";

const DEFAULT_MAX_FACTS = 1_000;

export interface BuildActivityContextPackInput {
  runId: string;
  projectId: string;
  profile: AnalysisProfile;
  baselineDigest: string;
  deadlineAt: string;
  afterWatermark?: number;
  atOrBeforeSnapshotBoundary?: number;
  eventNames?: ActivityEventName[];
  maxFacts?: number;
}

export class EvolutionContextPackBuilder {
  constructor(
    private readonly activity: ActivityQueryService,
    private readonly store: EvolutionContextPackStore,
    private readonly now: () => Date = () => new Date(),
    private readonly supplementalSources?: EvolutionSupplementalSourceReader,
  ) {}

  async buildActivityPack(
    input: BuildActivityContextPackInput,
  ): Promise<ContextPackManifest> {
    const runId = input.runId.trim();
    const baselineDigest = input.baselineDigest.trim();
    if (!runId) throw new Error("evolution_context_pack_run_id_required");
    if (!baselineDigest) {
      throw new Error("evolution_context_pack_baseline_digest_required");
    }
    const deadlineAtMs = Date.parse(input.deadlineAt);
    if (!Number.isFinite(deadlineAtMs)) {
      throw new Error("evolution_context_pack_invalid_deadline");
    }

    const learningScope = resolveEvolutionLearningScope(input.projectId);
    const normalizedDeadlineAt = new Date(deadlineAtMs).toISOString();
    const existing = await this.store.getContextPackByRun(runId);
    if (existing) {
      const activitySource = existing.sources.find(
        (source) => source.source === "activity",
      );
      if (
        existing.learningScope.learningScopeId !==
          learningScope.learningScopeId ||
        existing.profile !== input.profile ||
        existing.baselineDigest !== baselineDigest ||
        existing.deadlineAt !== normalizedDeadlineAt ||
        activitySource?.afterWatermark !== String(input.afterWatermark ?? 0) ||
        (input.atOrBeforeSnapshotBoundary !== undefined &&
          activitySource.snapshotBoundary !==
            String(input.atOrBeforeSnapshotBoundary))
      ) {
        throw new Error("evolution_context_pack_run_conflict");
      }
      return existing;
    }
    const requestedAfterWatermark = input.afterWatermark ?? 0;
    const pageSize = Math.max(
      1,
      Math.min(
        DEFAULT_MAX_FACTS,
        Math.floor(input.maxFacts ?? DEFAULT_MAX_FACTS),
      ),
    );
    let nextAfterWatermark = requestedAfterWatermark;
    let snapshotBoundary = input.atOrBeforeSnapshotBoundary;
    const facts: ActivityFactDto[] = [];
    while (true) {
      const page = await this.activity.evolutionSnapshot({
        learningScopeId: learningScope.learningScopeId,
        afterWatermark: nextAfterWatermark,
        ...(snapshotBoundary === undefined
          ? {}
          : { atOrBeforeSnapshotBoundary: snapshotBoundary }),
        eventNames: input.eventNames ?? [...ACTIVITY_EVENT_NAMES],
        limit: pageSize,
      });
      snapshotBoundary ??= page.snapshotBoundary;
      if (page.snapshotBoundary !== snapshotBoundary) {
        throw new Error("evolution_context_pack_snapshot_boundary_changed");
      }
      facts.push(...page.facts);
      if (!page.hasMore) break;
      if (
        page.nextWatermark === undefined ||
        page.nextWatermark <= nextAfterWatermark
      ) {
        throw new Error("evolution_context_pack_pagination_stalled");
      }
      nextAfterWatermark = page.nextWatermark;
    }
    const frozenSnapshotBoundary = snapshotBoundary ?? requestedAfterWatermark;
    const activityEvidence = facts.map((fact) =>
      toEvidence(fact, deadlineAtMs),
    );
    const activityDataQualityIssues = activityEvidence.flatMap((item) =>
      unavailableContentIssues(item),
    );
    const activitySource: SourceBoundary = {
      sourceId: "activity",
      source: "activity",
      afterWatermark: String(requestedAfterWatermark),
      snapshotBoundary: String(frozenSnapshotBoundary),
      processedThrough: String(frozenSnapshotBoundary),
      digest: sha256(canonicalJson(activityEvidence)),
      recordCount: activityEvidence.length,
      truncated: false,
    };
    const supplemental = this.supplementalSources
      ? await this.supplementalSources.collect({
          learningScope,
          activityEvidence,
          afterWatermark: activitySource.afterWatermark,
          snapshotBoundary: activitySource.snapshotBoundary,
        })
      : { sources: [], evidence: [], dataQualityIssues: [] };
    const sources = [activitySource, ...supplemental.sources];
    const evidence = [...activityEvidence, ...supplemental.evidence];
    const dataQualityIssues = [
      ...activityDataQualityIssues,
      ...supplemental.dataQualityIssues,
    ];
    const digest = sha256(
      canonicalJson({
        learningScopeId: learningScope.learningScopeId,
        sources,
        profile: input.profile,
        baselineDigest,
      }),
    );
    const manifest: ContextPackManifest = {
      schemaVersion: 1,
      contextPackId: `context-pack:${runId}`,
      runId,
      learningScope,
      profile: input.profile,
      baselineDigest,
      createdAt: this.now().toISOString(),
      deadlineAt: normalizedDeadlineAt,
      digest,
      sources,
      evidence,
      dataQualityIssues,
    };
    await this.store.putContextPack(manifest);
    return manifest;
  }
}

function toEvidence(
  fact: ActivityFactDto,
  deadlineAtMs: number,
): ContextPackEvidenceRef {
  const evidenceId = `activity:${fact.eventId}`;
  const contentRefs = fact.contentDescriptors.map((descriptor) =>
    toContentRef(descriptor, deadlineAtMs),
  );
  return {
    evidenceId,
    source: "activity",
    sourceRecordId: fact.eventId,
    digest: sha256(
      canonicalJson({
        activityOffset: fact.activityOffset,
        eventId: fact.eventId,
        eventName: fact.eventName,
        occurredAt: fact.occurredAt,
        producer: fact.producer,
        actor: fact.actor,
        runtime: fact.runtime,
        scope: fact.scope,
        correlationId: fact.correlationId ?? null,
        causationId: fact.causationId ?? null,
        parentEventId: fact.parentEventId ?? null,
        result: fact.result ?? null,
        payload: fact.payload,
        contentDescriptors: fact.contentDescriptors,
        externalRefDescriptors: fact.externalRefDescriptors,
      }),
    ),
    availability: "available",
    activity: {
      activityOffset: fact.activityOffset,
      eventName: fact.eventName,
      occurredAt: fact.occurredAt,
      producerName: fact.producer.name,
      actorType: fact.actor.type,
      runtimeSurface: fact.runtime.surface,
      resultStatus: fact.result?.status ?? null,
      resultCode: fact.result?.code ?? null,
      payload: fact.payload,
    },
    origin: {
      projectId: fact.scope.projectId ?? null,
      path: fact.scope.cwd ?? null,
      branch: null,
      revision: fact.runtime.sourceRevision ?? null,
    },
    relationships: {
      terminalSessionId: fact.scope.terminalSessionId ?? null,
      threadId: fact.scope.threadId ?? null,
      runId: fact.scope.runId ?? null,
      interactionId: fact.scope.interactionId ?? null,
      correlationId: fact.correlationId ?? null,
      causationId: fact.causationId ?? null,
      parentEventId: fact.parentEventId ?? null,
    },
    contentRefs,
  };
}

function toContentRef(
  descriptor: ActivityContentDescriptorDto,
  deadlineAtMs: number,
): ContextPackContentRef {
  if (descriptor.availability !== "available") {
    return {
      contentId: descriptor.contentId,
      sha256: descriptor.sha256,
      availability: "unavailable",
      expectedExpiresAt: descriptor.expectedExpiresAt,
      unavailableReason: descriptor.availability,
    };
  }
  if (Date.parse(descriptor.expectedExpiresAt) <= deadlineAtMs) {
    return {
      contentId: descriptor.contentId,
      sha256: descriptor.sha256,
      availability: "unavailable",
      expectedExpiresAt: descriptor.expectedExpiresAt,
      unavailableReason: "expires_before_run_deadline",
    };
  }
  return {
    contentId: descriptor.contentId,
    sha256: descriptor.sha256,
    availability: "available",
    expectedExpiresAt: descriptor.expectedExpiresAt,
    unavailableReason: null,
  };
}

function unavailableContentIssues(
  evidence: ContextPackEvidenceRef,
): DataQualityIssue[] {
  return evidence.contentRefs.flatMap((content) =>
    content.availability === "available"
      ? []
      : [
          {
            issueId: `data-quality:${sha256(`${evidence.evidenceId}\0${content.contentId}`).slice(0, 24)}`,
            source: "activity" as const,
            code: `activity_content_${content.unavailableReason}`,
            severity: "warning" as const,
            detail: "Activity content is unavailable for the frozen run.",
            evidenceIds: [evidence.evidenceId],
          },
        ],
  );
}
