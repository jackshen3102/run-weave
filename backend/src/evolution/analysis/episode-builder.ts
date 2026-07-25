import { createHash } from "node:crypto";
import type {
  ContextPackEvidenceRef,
  ContextPackManifest,
  Episode,
  EpisodeEvidenceRef,
  TraceSegment,
} from "@runweave/shared/evolution";

export function buildEpisodes(
  manifest: ContextPackManifest,
  segments: TraceSegment[],
): Episode[] {
  const evidenceById = new Map(
    manifest.evidence.map((evidence) => [evidence.evidenceId, evidence]),
  );
  const parent = new Map(segments.map((segment) => [segment.segmentId, segment.segmentId]));
  const find = (id: string): string => {
    const current = parent.get(id);
    if (!current || current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  const union = (left: string, right: string): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };

  const ownerByRelation = new Map<string, string>();
  for (const segment of segments) {
    const relations = new Set(
      segment.evidenceIds.flatMap((id) => {
        const evidence = evidenceById.get(id);
        return evidence ? evidenceRelations(evidence) : [];
      }),
    );
    for (const relation of relations) {
      const owner = ownerByRelation.get(relation);
      if (owner) union(owner, segment.segmentId);
      else ownerByRelation.set(relation, segment.segmentId);
    }
  }

  const components = new Map<string, TraceSegment[]>();
  for (const segment of segments) {
    const root = find(segment.segmentId);
    components.set(root, [...(components.get(root) ?? []), segment]);
  }
  return Array.from(components.values())
    .filter((component) => component.length > 0)
    .sort(
      (left, right) =>
        (left[0]?.sequence ?? 0) - (right[0]?.sequence ?? 0),
    )
    .flatMap((component) => {
      const episode = toEpisode(manifest, component, evidenceById);
      return episode ? [episode] : [];
    });
}

function evidenceRelations(evidence: ContextPackEvidenceRef): string[] {
  const directKeys = [
    "threadId",
    "runId",
    "interactionId",
    "correlationId",
    "terminalSessionId",
  ] as const;
  const relations = directKeys.flatMap((key) => {
    const value = evidence.relationships[key];
    return value ? [`${key}:${value}`] : [];
  });
  for (const value of [
    evidence.sourceRecordId,
    evidence.relationships.parentEventId,
    evidence.relationships.causationId,
  ]) {
    if (value) relations.push(`event:${value}`);
  }
  return relations;
}

function toEpisode(
  manifest: ContextPackManifest,
  segments: TraceSegment[],
  evidenceById: Map<string, ContextPackEvidenceRef>,
): Episode | null {
  const ordered = [...segments].sort((left, right) => left.sequence - right.sequence);
  const first = ordered[0];
  if (!first) return null;
  const evidence: EpisodeEvidenceRef[] = ordered.flatMap((segment) =>
    segment.evidenceIds.map((evidenceId) => ({
      evidenceId,
      segmentId: segment.segmentId,
      role: evidenceRole(evidenceById.get(evidenceId)),
    })),
  );
  const anchor = ordered.find(
    (segment) => segment.relationKind === "agent_team_run",
  ) ?? first;
  const segmentIds = ordered.map((segment) => segment.segmentId);
  return {
    episodeId: stableId("episode", [manifest.runId, ...segmentIds]),
    runId: manifest.runId,
    learningScopeId: manifest.learningScope.learningScopeId,
    title: `${anchor.relationKind}:${anchor.relationId}`,
    segmentIds,
    evidence,
    boundaryConfidence: ordered.length > 1 ? 0.9 : 1,
    boundaryReason:
      ordered.length > 1
        ? "authoritative_identity_or_causation_link"
        : "single_authoritative_segment",
    createdAt: manifest.createdAt,
  };
}

function evidenceRole(
  evidence: ContextPackEvidenceRef | undefined,
): EpisodeEvidenceRef["role"] {
  if (!evidence) return "fact";
  if (evidence.relationships.runId) return "attempt";
  if (
    evidence.relationships.causationId ||
    evidence.relationships.parentEventId
  ) {
    return "outcome";
  }
  return "fact";
}

function stableId(prefix: string, values: string[]): string {
  return `${prefix}_${createHash("sha256")
    .update(values.join("\n"))
    .digest("hex")
    .slice(0, 24)}`;
}
