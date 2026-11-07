import type {
  ExperienceEvidence,
  ExperienceEvidenceInput,
  ExperienceRecord,
} from "@runweave/shared/experience";
import { inspectEvidence, snapshotEvidence } from "./evidence";
import type { LearningFact } from "./learning-source";

/** Keep adjacent source lines together without exceeding the excerpt budget. */
export function learningEvidenceRanges(
  facts: LearningFact[],
  proof: string,
  threadId: string,
): ExperienceEvidenceInput[] {
  const ranges: ExperienceEvidenceInput[] = [];
  let bytes = 0;
  for (const [index, fact] of facts.entries()) {
    const size = Buffer.byteLength(JSON.stringify(fact) + "\n");
    if (!ranges.length || bytes + size > 60_000) {
      ranges.push({
        path: proof,
        startLine: index + 1,
        endLine: index + 1,
        note: `Observed tool evidence for ${threadId}`,
      });
      bytes = 0;
    }
    ranges.at(-1)!.endLine = index + 1;
    bytes += size;
  }
  return ranges;
}

export async function retainLearningEvidence(
  current: ExperienceEvidence[],
  previous: ExperienceEvidence[] = [],
): Promise<ExperienceEvidence[]> {
  const result = [...current];
  for (const evidence of previous) {
    if (await inspectEvidence(evidence))
      throw new Error("experience_previous_evidence_invalid");
    const retained = evidence.archived
      ? evidence
      : await snapshotEvidence(evidence);
    if (retained.sha256 !== evidence.sha256)
      throw new Error("experience_previous_evidence_changed");
    if (
      !result.some(
        (item) =>
          item.path === retained.path &&
          item.startLine === retained.startLine &&
          item.endLine === retained.endLine &&
          item.sha256 === retained.sha256,
      )
    )
      result.push(retained);
  }
  if (result.length > 10)
    throw new Error("experience_retained_evidence_budget_exceeded");
  return result;
}

/** Historical excerpts can support past conditions, never this turn's tool pair. */
export function historicalLearningFacts(
  record: ExperienceRecord,
  proof: string,
): LearningFact[] {
  return record.evidence
    .filter((evidence) => evidence.path !== proof && evidence.archived)
    .map((evidence, index) => ({
      id: `historical:${record.revision}:${index}`,
      kind: "historical.evidence",
      toolUseId: null,
      toolName: null,
      text: JSON.stringify({
        path: evidence.path,
        startLine: evidence.startLine,
        endLine: evidence.endLine,
        note: evidence.note,
        text: evidence.archived!.text,
      }),
    }));
}

/** Raw historical excerpts are supplied once, separately from record metadata. */
export function learningReviewRecord(record?: ExperienceRecord) {
  return record
    ? {
        ...record,
        evidence: record.evidence.map(
          ({ path, startLine, endLine, note, sha256 }) => ({
            path,
            startLine,
            endLine,
            note,
            sha256,
          }),
        ),
      }
    : null;
}
