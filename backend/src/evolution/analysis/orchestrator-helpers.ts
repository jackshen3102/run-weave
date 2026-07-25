import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import type {
  ContextPackManifest,
  EvolutionAnalysisReport,
  EvolutionAnalystRole,
  EvolutionRunStage,
  Insight,
} from "@runweave/shared/evolution";
import type { EvolutionRunClaim as FoundationRunClaim } from "../foundation-store";
import type { EvolutionProviderName } from "../providers/types";
import type { AnalystOutput, CrossQuestionOutput } from "./output-schemas";

export const ANALYSIS_TOOLS = [
  "context.describe",
  "activity.summarize_facts",
  "activity.search_facts",
  "activity.get_content",
  "history.get_thread",
  "history.get_agent_team_run",
  "source.search",
  "source.read",
  "evidence.batch_get_metadata",
];

export const TERMINAL_RUN_STAGES = new Set<EvolutionRunStage>([
  "completed",
  "no_material_novelty",
  "partial",
  "failed",
  "cancelled",
  "blocked",
]);

const TEMPORARY_DIRECTORY_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-(analyst_a|analyst_b|cross_examiner|judge)-[a-z0-9]{6}$/iu;

export async function cleanupEvolutionTemporaryDirectories(
  temporaryRoot: string,
  isActive: (runId: string, role: string) => Promise<boolean>,
): Promise<number> {
  let entries;
  try {
    entries = await readdir(temporaryRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = TEMPORARY_DIRECTORY_PATTERN.exec(entry.name);
    const runId = match?.[1];
    const role = match?.[2];
    if (!runId || !role || (await isActive(runId, role))) continue;
    await rm(path.join(temporaryRoot, entry.name), {
      recursive: true,
      force: true,
    });
    removed += 1;
  }
  return removed;
}

export function toAnalysisReport(params: {
  claim: FoundationRunClaim;
  role: Extract<EvolutionAnalystRole, "analyst_a" | "analyst_b">;
  provider: EvolutionProviderName;
  output: AnalystOutput;
  visibleReportIds: string[];
  createdAt: string;
}): EvolutionAnalysisReport {
  const reportId = stableId("report", [
    params.claim.run.runId,
    params.role,
    JSON.stringify(params.output),
  ]);
  return {
    reportId,
    runId: params.claim.run.runId,
    attemptNumber: params.claim.run.attempt,
    role: params.role,
    provider: params.provider,
    summary: params.output.summary,
    observedFacts: params.output.observedFacts.map((fact) => ({
      factId: stableId("fact", [reportId, fact.statement, ...fact.evidenceIds]),
      ...fact,
    })),
    assessments: params.output.assessments,
    claims: params.output.claims,
    crossReviews: [],
    visibleReportIds: params.visibleReportIds,
    createdAt: params.createdAt,
  };
}

export function validateAnalystOutput(
  output: AnalystOutput,
  manifest: ContextPackManifest,
): void {
  validateEvidenceIds(
    [
      ...output.observedFacts.flatMap((fact) => fact.evidenceIds),
      ...output.assessments.flatMap((assessment) => assessment.evidenceIds),
      ...output.claims.flatMap((claim) => [
        ...claim.supportingEvidenceIds,
        ...claim.counterEvidenceIds,
      ]),
    ],
    manifest,
  );
}

export function validateCrossQuestionOutput(
  output: CrossQuestionOutput,
  manifest: ContextPackManifest,
): void {
  validateEvidenceIds(
    output.reviews.flatMap((review) => review.counterEvidenceIds),
    manifest,
  );
}

export function validateEvidenceIds(
  evidenceIds: string[],
  manifest: ContextPackManifest,
): void {
  const known = new Set(manifest.evidence.map((item) => item.evidenceId));
  if (evidenceIds.some((evidenceId) => !known.has(evidenceId))) {
    throw new Error("evolution_evidence_reference_out_of_boundary");
  }
}

export function baselineDigest(insights: Insight[]): string {
  return stableId(
    "baseline",
    insights.flatMap((insight) => [
      insight.insightId,
      insight.currentRevisionId,
    ]),
  );
}

export function numericWatermark(value: string | null): number {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function terminalOutcome(
  error: unknown,
): Extract<EvolutionRunStage, "partial" | "failed" | "blocked"> {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("provider") && message.includes("unavailable")) {
    return "blocked";
  }
  if (
    message.includes("budget") ||
    message.includes("timeout") ||
    message.includes("wall_time")
  ) {
    return "partial";
  }
  return "failed";
}

export function providerErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("timeout") || message.includes("wall_time")) {
    return "provider_timeout";
  }
  if (message.includes("cancel")) return "provider_cancelled";
  if (message.includes("invalid_json")) return "provider_output_invalid_json";
  if (message.includes("schema")) return "provider_output_schema_rejected";
  if (message.includes("output_limit")) return "provider_output_limit_exceeded";
  return "provider_failed";
}

export function stableId(prefix: string, values: string[]): string {
  return `${prefix}_${createHash("sha256")
    .update(values.join("\n"))
    .digest("hex")
    .slice(0, 24)}`;
}
