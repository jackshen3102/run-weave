import { createHash } from "node:crypto";
import type {
  ContextPackEvidenceRef,
  ContextPackManifest,
  TraceSegment,
} from "@runweave/shared/evolution";

export function segmentContextPack(manifest: ContextPackManifest): TraceSegment[] {
  const groups = new Map<
    string,
    {
      relationKind: TraceSegment["relationKind"];
      relationId: string;
      evidenceIds: string[];
    }
  >();
  for (const evidence of manifest.evidence) {
    const relation = strongestRelation(evidence);
    const key = `${relation.kind}\0${relation.id}`;
    const group = groups.get(key) ?? {
      relationKind: relation.kind,
      relationId: relation.id,
      evidenceIds: [],
    };
    group.evidenceIds.push(evidence.evidenceId);
    groups.set(key, group);
  }
  return Array.from(groups.values())
    .sort(
      (left, right) =>
        left.relationKind.localeCompare(right.relationKind) ||
        left.relationId.localeCompare(right.relationId),
    )
    .map((group, sequence) => ({
      segmentId: stableId("segment", [
        manifest.runId,
        group.relationKind,
        group.relationId,
      ]),
      runId: manifest.runId,
      learningScopeId: manifest.learningScope.learningScopeId,
      sequence,
      relationKind: group.relationKind,
      relationId: group.relationId,
      evidenceIds: group.evidenceIds.sort(),
      createdAt: manifest.createdAt,
    }));
}

function strongestRelation(evidence: ContextPackEvidenceRef): {
  kind: TraceSegment["relationKind"];
  id: string;
} {
  if (evidence.relationships.runId) {
    return { kind: "agent_team_run", id: evidence.relationships.runId };
  }
  if (evidence.relationships.threadId) {
    return { kind: "thread", id: evidence.relationships.threadId };
  }
  if (evidence.relationships.interactionId) {
    return {
      kind: "interaction",
      id: evidence.relationships.interactionId,
    };
  }
  if (evidence.relationships.terminalSessionId) {
    return {
      kind: "terminal",
      id: evidence.relationships.terminalSessionId,
    };
  }
  return { kind: "standalone", id: evidence.sourceRecordId };
}

function stableId(prefix: string, values: string[]): string {
  return `${prefix}_${createHash("sha256")
    .update(values.join("\n"))
    .digest("hex")
    .slice(0, 24)}`;
}
