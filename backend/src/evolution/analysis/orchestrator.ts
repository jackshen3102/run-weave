import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ContextPackManifest,
  EvolutionAnalysisReport,
  EvolutionAnalystRole,
  EvolutionClaim,
  EvolutionRunAttempt,
  EvolutionRunStage,
} from "@runweave/shared/evolution";
import type { EvolutionAnalysisStore } from "../analysis-store";
import type { EvolutionContextPackBuilder } from "../context-pack";
import type {
  EvolutionFoundationStore,
  EvolutionRunClaim as FoundationRunClaim,
} from "../foundation-store";
import { segmentContextPack } from "../trace-segmenter";
import { EvolutionToolTokenRegistry } from "../tools/token-registry";
import { EvolutionProviderAvailabilityService } from "../providers/availability";
import { CodexEvolutionProvider } from "../providers/codex";
import { TraeEvolutionProvider } from "../providers/trae";
import type {
  EvolutionProviderAdapter,
  EvolutionProviderName,
} from "../providers/types";
import {
  selectEvolutionProviders,
  type EvolutionProviderAssignment,
} from "../providers/selection";
import { buildEpisodes } from "./episode-builder";
import { buildClaimLedger } from "./claim-ledger";
import { classifyClaimNovelty } from "./novelty-gate";
import {
  analystOutputJsonSchema,
  analystOutputSchema,
  crossQuestionOutputJsonSchema,
  crossQuestionOutputSchema,
  type CrossQuestionOutput,
} from "./output-schemas";
import { buildAnalystPrompt, buildCrossQuestionPrompt } from "./prompts";
import { EvolutionInsightService } from "../knowledge/insight-service";
import {
  ANALYSIS_TOOLS,
  TERMINAL_RUN_STAGES,
  baselineDigest,
  cleanupEvolutionTemporaryDirectories,
  numericWatermark,
  providerErrorCode,
  stableId,
  terminalOutcome,
  toAnalysisReport,
  validateAnalystOutput,
  validateCrossQuestionOutput,
  validateEvidenceIds,
} from "./orchestrator-helpers";

export class EvolutionAnalysisOrchestrator {
  private readonly providers: Record<
    EvolutionProviderName,
    EvolutionProviderAdapter
  >;

  constructor(
    private readonly foundationStore: EvolutionFoundationStore,
    private readonly analysisStore: EvolutionAnalysisStore,
    private readonly contextPackBuilder: EvolutionContextPackBuilder,
    private readonly tokenRegistry: EvolutionToolTokenRegistry,
    private readonly providerAvailability: EvolutionProviderAvailabilityService,
    private readonly temporaryRoot: string,
    providers?: Partial<
      Record<EvolutionProviderName, EvolutionProviderAdapter>
    >,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.providers = {
      codex: providers?.codex ?? new CodexEvolutionProvider(),
      trae: providers?.trae ?? new TraeEvolutionProvider(),
    };
  }

  async cleanupOrphanedTemporaryDirectories(): Promise<number> {
    return cleanupEvolutionTemporaryDirectories(
      this.temporaryRoot,
      async (runId, role) => {
        const run = await this.foundationStore.getRun(runId);
        const attempts = run
          ? await this.analysisStore.listRunAttempts(runId)
          : [];
        return (
          run !== null &&
          !TERMINAL_RUN_STAGES.has(run.stage) &&
          attempts.some(
            (attempt) => attempt.role === role && attempt.status === "running",
          )
        );
      },
    );
  }

  async execute(
    claim: FoundationRunClaim,
    controlPlaneBaseUrl: string,
    signal: AbortSignal,
  ): Promise<void> {
    let stage: EvolutionRunStage = "snapshotting";
    const startedAtMs = Date.parse(claim.run.startedAt ?? claim.run.createdAt);
    const deadlineAtMs = startedAtMs + claim.run.budget.maxWallTimeMs;
    try {
      const baseline = await this.analysisStore.listInsights(
        claim.run.learningScopeId,
      );
      const manifest = await this.contextPackBuilder.buildActivityPack({
        runId: claim.run.runId,
        projectId: claim.run.learningScopeId,
        profile: claim.run.profile,
        baselineDigest: baselineDigest(baseline),
        deadlineAt: new Date(deadlineAtMs).toISOString(),
        afterWatermark: numericWatermark(claim.run.dataRange.afterWatermark),
        maxFacts: Math.max(
          1,
          Math.min(1_000, Math.floor(claim.run.budget.maxContextBytes / 1_000)),
        ),
      });
      await this.transition(claim, stage, "segmenting");
      stage = "segmenting";

      const segments = segmentContextPack(manifest);
      await this.analysisStore.putTraceSegments(segments);
      const episodes = buildEpisodes(manifest, segments);
      await this.analysisStore.putEpisodes(episodes);
      await this.transition(claim, stage, "independent_analysis");
      stage = "independent_analysis";

      const reports =
        manifest.evidence.length === 0
          ? []
          : await this.runIndependentAnalysis({
              claim,
              manifest,
              controlPlaneBaseUrl,
              deadlineAtMs,
              signal,
            });
      if (
        manifest.evidence.length > 0 &&
        claim.run.profile !== "quick" &&
        reports.filter((report) => report.role.startsWith("analyst_")).length <
          2
      ) {
        await this.transitionTerminal(claim, stage, "partial");
        return;
      }
      await this.transition(claim, stage, "cross_questioning");
      stage = "cross_questioning";

      let crossQuestion: CrossQuestionOutput | null = null;
      if (reports.length > 1) {
        crossQuestion = await this.runCrossQuestion({
          claim,
          manifest,
          reports,
          controlPlaneBaseUrl,
          deadlineAtMs,
          signal,
          role: "cross_examiner",
        });
      }
      let claims = this.buildAndValidateClaims(
        claim,
        manifest,
        reports,
        crossQuestion,
      );
      const shouldJudge =
        claim.run.profile === "deep" &&
        claims.some(
          (item) => item.status === "contested" || item.risk === "high",
        );
      if (shouldJudge) {
        await this.transition(claim, stage, "adjudicating");
        stage = "adjudicating";
        const judgment = await this.runCrossQuestion({
          claim,
          manifest,
          reports,
          controlPlaneBaseUrl,
          deadlineAtMs,
          signal,
          role: "judge",
        });
        claims = this.buildAndValidateClaims(
          claim,
          manifest,
          reports,
          judgment,
        );
      }
      await this.transition(claim, stage, "novelty_check");
      stage = "novelty_check";
      await this.analysisStore.putClaims(claims);
      const novelty = classifyClaimNovelty(claims, baseline);
      await this.analysisStore.putClaimNovelty(novelty);

      await this.transition(claim, stage, "validating");
      stage = "validating";
      const knowledge = await new EvolutionInsightService(
        this.analysisStore,
      ).prepare({
        runId: claim.run.runId,
        learningScopeId: claim.run.learningScopeId,
        claims,
        novelty,
        createdAt: this.now().toISOString(),
      });
      const activityBoundary = manifest.sources.find(
        (source) => source.source === "activity",
      );
      const finalizedAt = this.now().toISOString();
      const outcome =
        knowledge.revisions.length === 0 && knowledge.candidates.length === 0
          ? "no_material_novelty"
          : "completed";
      await this.analysisStore.commitRunKnowledge({
        runId: claim.run.runId,
        ownerId: claim.ownerId,
        fencingToken: claim.fencingToken,
        now: finalizedAt,
        outcome,
        insights: knowledge.insights,
        candidates: knowledge.candidates,
        watermark: activityBoundary
          ? {
              learningScopeId: claim.run.learningScopeId,
              source: "activity",
              value:
                activityBoundary.processedThrough ??
                (activityBoundary.truncated
                  ? (activityBoundary.afterWatermark ?? "0")
                  : activityBoundary.snapshotBoundary),
              runId: claim.run.runId,
              updatedAt: finalizedAt,
            }
          : null,
      });
    } catch (error) {
      if (signal.aborted || (await this.isCancelled(claim.run.runId))) return;
      const outcome = terminalOutcome(error);
      await this.transitionTerminal(claim, stage, outcome).catch(
        () => undefined,
      );
      throw error;
    } finally {
      this.tokenRegistry.revokeRun(claim.run.runId);
    }
  }

  private async runIndependentAnalysis(params: {
    claim: FoundationRunClaim;
    manifest: ContextPackManifest;
    controlPlaneBaseUrl: string;
    deadlineAtMs: number;
    signal: AbortSignal;
  }): Promise<EvolutionAnalysisReport[]> {
    const existing = await this.analysisStore.listAnalysisReports(
      params.claim.run.runId,
    );
    const analystExisting = existing.filter(
      (report) => report.role === "analyst_a" || report.role === "analyst_b",
    );
    const assignments = await this.resolveProviderAssignments(params.claim);
    const roles: Array<
      Extract<EvolutionAnalystRole, "analyst_a" | "analyst_b">
    > =
      params.claim.run.profile === "quick"
        ? ["analyst_a"]
        : (["analyst_a", "analyst_b"].slice(
            0,
            params.claim.run.budget.maxAgents,
          ) as Array<Extract<EvolutionAnalystRole, "analyst_a" | "analyst_b">>);
    const reports: EvolutionAnalysisReport[] = [];
    for (const [index, role] of roles.entries()) {
      const persisted = analystExisting.find((report) => report.role === role);
      if (persisted) {
        reports.push(persisted);
        continue;
      }
      const assignment = assignments[index];
      if (!assignment) throw new Error("evolution_provider_unavailable");
      const provider = assignment.provider;
      const output = await this.runProvider({
        claim: params.claim,
        manifest: params.manifest,
        controlPlaneBaseUrl: params.controlPlaneBaseUrl,
        deadlineAtMs: params.deadlineAtMs,
        signal: params.signal,
        provider,
        selectionReason: assignment.selectionReason,
        role,
        prompt: buildAnalystPrompt({
          role,
          manifest: params.manifest,
          budget: params.claim.run.budget,
        }),
        jsonSchema: analystOutputJsonSchema(),
        parse: (value) => analystOutputSchema.parse(value),
      });
      validateAnalystOutput(output, params.manifest);
      const report = toAnalysisReport({
        claim: params.claim,
        role,
        provider,
        output,
        visibleReportIds: [],
        createdAt: this.now().toISOString(),
      });
      await this.analysisStore.putAnalysisReport(report);
      await this.linkAttemptReport(
        params.claim,
        role,
        provider,
        report.reportId,
      );
      reports.push(report);
    }
    return reports;
  }

  private async runCrossQuestion(params: {
    claim: FoundationRunClaim;
    manifest: ContextPackManifest;
    reports: EvolutionAnalysisReport[];
    controlPlaneBaseUrl: string;
    deadlineAtMs: number;
    signal: AbortSignal;
    role: Extract<EvolutionAnalystRole, "cross_examiner" | "judge">;
  }): Promise<CrossQuestionOutput> {
    const existing = (
      await this.analysisStore.listAnalysisReports(params.claim.run.runId)
    ).find((report) => report.role === params.role);
    if (existing) return { reviews: existing.crossReviews };
    const assignments = await this.resolveProviderAssignments(params.claim);
    const assignment = assignments[0];
    if (!assignment) throw new Error("evolution_provider_unavailable");
    const provider = assignment.provider;
    const output = await this.runProvider({
      claim: params.claim,
      manifest: params.manifest,
      controlPlaneBaseUrl: params.controlPlaneBaseUrl,
      deadlineAtMs: params.deadlineAtMs,
      signal: params.signal,
      provider,
      selectionReason: assignment.selectionReason,
      role: params.role,
      prompt: buildCrossQuestionPrompt({
        manifest: params.manifest,
        reports: params.reports,
      }),
      jsonSchema: crossQuestionOutputJsonSchema(),
      parse: (value) => crossQuestionOutputSchema.parse(value),
    });
    validateCrossQuestionOutput(output, params.manifest);
    const report: EvolutionAnalysisReport = {
      reportId: stableId("report", [
        params.claim.run.runId,
        params.role,
        JSON.stringify(output),
      ]),
      runId: params.claim.run.runId,
      attemptNumber: params.claim.run.attempt,
      role: params.role,
      provider,
      summary: `${params.role} reviewed ${output.reviews.length} topics.`,
      observedFacts: [],
      assessments: [],
      claims: [],
      crossReviews: output.reviews,
      visibleReportIds: params.reports
        .map((reportItem) => reportItem.reportId)
        .sort(),
      createdAt: this.now().toISOString(),
    };
    await this.analysisStore.putAnalysisReport(report);
    await this.linkAttemptReport(
      params.claim,
      params.role,
      provider,
      report.reportId,
    );
    return output;
  }

  private async runProvider<T>(params: {
    claim: FoundationRunClaim;
    manifest: ContextPackManifest;
    controlPlaneBaseUrl: string;
    deadlineAtMs: number;
    signal: AbortSignal;
    provider: EvolutionProviderName;
    selectionReason: EvolutionRunAttempt["selectionReason"];
    role: EvolutionAnalystRole;
    prompt: string;
    jsonSchema: object;
    parse: (value: unknown) => T;
  }): Promise<T> {
    const attempts = await this.analysisStore.listRunAttempts(
      params.claim.run.runId,
    );
    if (attempts.length >= params.claim.run.budget.maxModelTurns) {
      throw new Error("evolution_model_turn_budget_exceeded");
    }
    if (
      Buffer.byteLength(params.prompt) > params.claim.run.budget.maxContextBytes
    ) {
      throw new Error("evolution_context_budget_exceeded");
    }
    const remainingMs = params.deadlineAtMs - this.now().getTime();
    if (remainingMs <= 0) throw new Error("evolution_wall_time_exceeded");
    await mkdir(this.temporaryRoot, { recursive: true, mode: 0o700 });
    const workingDirectory = await mkdtemp(
      path.join(
        this.temporaryRoot,
        `${params.claim.run.runId}-${params.role}-`,
      ),
    );
    await chmod(workingDirectory, 0o700);
    const outputSchemaPath = path.join(workingDirectory, "output-schema.json");
    await writeFile(
      outputSchemaPath,
      `${JSON.stringify(params.jsonSchema)}\n`,
      { mode: 0o600 },
    );
    const attemptId = `${params.claim.run.runId}:${params.claim.run.attempt}:${params.role}`;
    const startedAt = this.now().toISOString();
    await this.analysisStore.putRunAttempt({
      attemptId,
      runId: params.claim.run.runId,
      attemptNumber: params.claim.run.attempt,
      role: params.role,
      provider: params.provider,
      selectionReason: params.selectionReason,
      status: "running",
      startedAt,
      completedAt: null,
      errorCode: null,
      reportId: null,
    });
    const grant = this.tokenRegistry.issue({
      runId: params.claim.run.runId,
      attemptId,
      analystRole: params.role,
      allowedTools: ANALYSIS_TOOLS,
      maxToolCalls: params.claim.run.budget.maxToolCalls,
      ttlMs: remainingMs,
    });
    try {
      const result = await this.providers[params.provider].run({
        prompt: params.prompt,
        workingDirectory,
        outputSchemaPath,
        maxWallTimeMs: remainingMs,
        maxOutputBytes: Math.min(
          params.claim.run.budget.maxContextBytes,
          2_000_000,
        ),
        mcp: {
          url: new URL(
            "/internal/evolution/mcp",
            params.controlPlaneBaseUrl,
          ).toString(),
          bearerToken: grant.token,
        },
        signal: params.signal,
      });
      const output = params.parse(result.output);
      await this.analysisStore.putRunAttempt({
        attemptId,
        runId: params.claim.run.runId,
        attemptNumber: params.claim.run.attempt,
        role: params.role,
        provider: params.provider,
        selectionReason: params.selectionReason,
        status: "completed",
        startedAt,
        completedAt: this.now().toISOString(),
        errorCode: null,
        reportId: null,
      });
      return output;
    } catch (error) {
      await this.analysisStore.putRunAttempt({
        attemptId,
        runId: params.claim.run.runId,
        attemptNumber: params.claim.run.attempt,
        role: params.role,
        provider: params.provider,
        selectionReason: params.selectionReason,
        status: params.signal.aborted ? "cancelled" : "failed",
        startedAt,
        completedAt: this.now().toISOString(),
        errorCode: providerErrorCode(error),
        reportId: null,
      });
      throw error;
    } finally {
      this.tokenRegistry.revokeAttempt(attemptId);
      await rm(workingDirectory, { recursive: true, force: true });
    }
  }

  private async linkAttemptReport(
    claim: FoundationRunClaim,
    role: EvolutionAnalystRole,
    provider: EvolutionProviderName,
    reportId: string,
  ): Promise<void> {
    const attempt = (
      await this.analysisStore.listRunAttempts(claim.run.runId)
    ).find(
      (item) =>
        item.attemptNumber === claim.run.attempt &&
        item.role === role &&
        item.provider === provider,
    );
    if (!attempt || attempt.status !== "completed") return;
    await this.analysisStore.putRunAttempt({ ...attempt, reportId });
  }

  private async resolveProviderAssignments(
    claim: FoundationRunClaim,
  ): Promise<EvolutionProviderAssignment[]> {
    const statuses = await this.providerAvailability.list();
    return selectEvolutionProviders({
      policy: claim.run.providerPolicy,
      profile: claim.run.profile,
      availability: statuses,
    });
  }

  private buildAndValidateClaims(
    claim: FoundationRunClaim,
    manifest: ContextPackManifest,
    reports: EvolutionAnalysisReport[],
    crossQuestion: CrossQuestionOutput | null,
  ): EvolutionClaim[] {
    const claims = buildClaimLedger({
      runId: claim.run.runId,
      learningScopeId: claim.run.learningScopeId,
      reports,
      crossQuestion,
      createdAt: this.now().toISOString(),
    });
    validateEvidenceIds(
      claims.flatMap((item) => [
        ...item.supportingEvidenceIds,
        ...item.counterEvidenceIds,
      ]),
      manifest,
    );
    return claims;
  }

  private transition(
    claim: FoundationRunClaim,
    expectedStage: EvolutionRunStage,
    nextStage: EvolutionRunStage,
  ): Promise<unknown> {
    return this.foundationStore.transitionRun({
      runId: claim.run.runId,
      ownerId: claim.ownerId,
      fencingToken: claim.fencingToken,
      expectedStage,
      nextStage,
      now: this.now().toISOString(),
    });
  }

  private transitionTerminal(
    claim: FoundationRunClaim,
    expectedStage: EvolutionRunStage,
    nextStage: Extract<EvolutionRunStage, "partial" | "failed" | "blocked">,
  ): Promise<unknown> {
    return this.transition(claim, expectedStage, nextStage);
  }

  private async isCancelled(runId: string): Promise<boolean> {
    return (await this.foundationStore.getRun(runId))?.stage === "cancelled";
  }
}
