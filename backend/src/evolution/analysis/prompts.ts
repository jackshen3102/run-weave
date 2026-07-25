import type {
  ContextPackManifest,
  EvolutionAnalysisReport,
  EvolutionAnalystRole,
  EvolutionBudget,
} from "@runweave/shared/evolution";

export function buildAnalystPrompt(params: {
  role: Extract<EvolutionAnalystRole, "analyst_a" | "analyst_b">;
  manifest: ContextPackManifest;
  budget: EvolutionBudget;
}): string {
  return [
    `<evolution-analysis role="${params.role}" phase="independent">`,
    "Analyze only the frozen evidence available through runweave-evolution MCP.",
    "Call context.describe once, then call activity.summarize_facts once. The latter deterministically scans every frozen Activity fact and is the full-range coverage contract.",
    "Confirm activity.summarize_facts.coverage.fullyCovered before finalizing conclusions. If false, report the coverage gap instead of pretending the range is complete.",
    "Use activity.search_facts only with representative evidenceIds from the summary, then inspect still-available content or linked history for concrete examples. Do not page through the raw range.",
    "Do not infer missing history. Use exact Evidence IDs in every fact and claim.",
    "Keep observations separate from assessments and recommendations.",
    "The other analyst report is intentionally unavailable in this phase.",
    `runId: ${params.manifest.runId}`,
    `contextPackId: ${params.manifest.contextPackId}`,
    `evidenceCount: ${params.manifest.evidence.length}`,
    `maxToolCalls: ${params.budget.maxToolCalls}`,
    "</evolution-analysis>",
  ].join("\n");
}

export function buildCrossQuestionPrompt(params: {
  manifest: ContextPackManifest;
  reports: EvolutionAnalysisReport[];
}): string {
  const reportPayload = params.reports.map((report) => ({
    reportId: report.reportId,
    role: report.role,
    summary: report.summary,
    observedFacts: report.observedFacts,
    assessments: report.assessments,
    claims: report.claims,
  }));
  return [
    '<evolution-analysis role="cross_examiner" phase="cross_questioning">',
    "Review both frozen first-round reports. Do not rewrite them.",
    "For each topicKey, identify support, counterexamples, scope boundaries, and missing evidence.",
    "A matching conclusion is not corroboration unless both reports cite valid frozen evidence.",
    `runId: ${params.manifest.runId}`,
    JSON.stringify(reportPayload),
    "</evolution-analysis>",
  ].join("\n");
}
