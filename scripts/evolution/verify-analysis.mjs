import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ActivityQueryService } from "../../backend/src/activity/query-service.ts";
import { ActivityStore } from "../../backend/src/activity/activity-store.ts";
import { EvolutionContextPackBuilder } from "../../backend/src/evolution/context-pack.ts";
import { EvolutionEvidenceReconciler } from "../../backend/src/evolution/knowledge/evidence-reconciler.ts";
import { SqliteEvolutionActivationStore } from "../../backend/src/evolution/storage/store.ts";
import { EVOLUTION_GLOBAL_SCOPE_ID } from "../../packages/shared/src/evolution.ts";
import { buildTerminalChildProjectId } from "../../packages/shared/src/terminal/project-context.ts";
import {
  analysisFixtureState,
  capturedAt,
  createAnalysisHarness,
  createFact,
  createFactory,
  deadlineAt,
  rawContentMarker,
} from "./verify-analysis-fixture.mjs";
import {
  executeRun,
  verifyFencedKnowledgeCommit,
  verifyProviderSelectionPolicies,
  writeAnalysisVerificationResult,
} from "./verify-analysis-helpers.mjs";
import { verifyNoveltyQualityGates } from "./verify-novelty-quality.mjs";

async function verifyAnalysisFoundation() {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "runweave-evolution-analysis-"),
  );
  const activityHome = path.join(tempRoot, "activity");
  const evolutionDatabasePath = path.join(
    tempRoot,
    "evolution",
    "learning.sqlite",
  );
  const activityStore = await ActivityStore.create({
    databasePath: path.join(activityHome, "activity.sqlite"),
    env: {
      ...process.env,
      RUNWEAVE_ACTIVITY_WORKER_ENTRY: "",
      RUNWEAVE_ACTIVITY_TEST_MODE: "true",
      RUNWEAVE_ACTIVITY_HOME: activityHome,
    },
  });
  let evolutionStore = await SqliteEvolutionActivationStore.create({
    databasePath: evolutionDatabasePath,
    env: {
      ...process.env,
      RUNWEAVE_BETTER_SQLITE3_NATIVE_BINDING: "",
      RUNWEAVE_BETTER_SQLITE3_PACKAGE_DIR: "",
      RUNWEAVE_EVOLUTION_WORKER_ENTRY: "",
    },
  });
  try {
    const parentProjectId = "project:browser-viewer";
    const childA = buildTerminalChildProjectId(parentProjectId, "agent-team-1");
    const childB = buildTerminalChildProjectId(
      parentProjectId,
      "removed-agent-team-2",
    );
    const unrelatedProjectId = "project:unrelated";
    const factory = createFactory("scope-fixture");
    const expiringFact = createFact(
      factory,
      childB,
      "child-b-deleted-path",
      "/deleted/browser-viewer/.worktree/agent-team-2",
    );
    expiringFact.occurredAt = "2026-07-18T01:30:00.000Z";
    expiringFact.contents.push({
      contentId: randomUUID(),
      role: "response",
      mediaType: "text/plain; charset=utf-8",
      bytesBase64: Buffer.from(rawContentMarker).toString("base64"),
    });
    const initialFacts = [
      createFact(factory, parentProjectId, "parent", "/repo/browser-viewer"),
      createFact(
        factory,
        childA,
        "child-a",
        "/repo/browser-viewer/.worktree/agent-team-1",
      ),
      expiringFact,
      createFact(factory, unrelatedProjectId, "unrelated", "/repo/unrelated"),
    ];
    analysisFixtureState.currentEvidenceEventId = initialFacts[0].eventId;
    await activityStore.record(initialFacts, Date.parse(capturedAt));

    const builder = new EvolutionContextPackBuilder(
      new ActivityQueryService(activityStore),
      evolutionStore,
      () => new Date(capturedAt),
    );
    const firstPack = await builder.buildActivityPack({
      runId: "run:scope-snapshot-1",
      projectId: childA,
      profile: "standard",
      baselineDigest: "baseline:none",
      deadlineAt,
      eventNames: ["agent.response.observed"],
      maxFacts: 100,
    });
    assert.equal(firstPack.learningScope.learningScopeId, parentProjectId);
    assert.equal(firstPack.sources[0]?.recordCount, 3);
    assert.equal(firstPack.sources[0]?.truncated, false);
    assert.equal(
      firstPack.sources[0]?.processedThrough,
      firstPack.sources[0]?.snapshotBoundary,
    );
    assert.deepEqual(
      new Set(firstPack.evidence.map((evidence) => evidence.origin.projectId)),
      new Set([parentProjectId, childA, childB]),
    );
    assert.equal(
      firstPack.evidence.some(
        (evidence) => evidence.origin.projectId === unrelatedProjectId,
      ),
      false,
    );
    assert.ok(
      firstPack.evidence.some(
        (evidence) =>
          evidence.origin.projectId === childB &&
          evidence.origin.path ===
            "/deleted/browser-viewer/.worktree/agent-team-2",
      ),
      "historical child identity must not depend on its path still existing",
    );
    const expiringEvidence = firstPack.evidence.find(
      (evidence) => evidence.sourceRecordId === expiringFact.eventId,
    );
    assert.equal(expiringEvidence?.contentRefs[0]?.availability, "unavailable");
    assert.equal(
      expiringEvidence?.contentRefs[0]?.unavailableReason,
      "expires_before_run_deadline",
    );

    const frozenEvidenceIds = firstPack.evidence.map(
      (evidence) => evidence.evidenceId,
    );
    const lateFact = createFact(
      factory,
      childA,
      "after-snapshot",
      "/repo/browser-viewer/.worktree/agent-team-1",
    );
    await activityStore.record([lateFact], Date.parse(capturedAt) + 1);

    const persistedFirstPack = await builder.buildActivityPack({
      runId: firstPack.runId,
      projectId: childB,
      profile: "standard",
      baselineDigest: "baseline:none",
      deadlineAt,
      eventNames: ["agent.response.observed"],
      maxFacts: 100,
    });
    assert.equal(persistedFirstPack.digest, firstPack.digest);
    assert.deepEqual(
      persistedFirstPack.evidence.map((evidence) => evidence.evidenceId),
      frozenEvidenceIds,
      "facts appended after snapshot must not change an existing pack",
    );

    const secondPack = await builder.buildActivityPack({
      runId: "run:scope-snapshot-2",
      projectId: parentProjectId,
      profile: "standard",
      baselineDigest: "baseline:none",
      deadlineAt,
      eventNames: ["agent.response.observed"],
      maxFacts: 100,
    });
    assert.equal(secondPack.sources[0]?.recordCount, 4);
    assert.ok(
      secondPack.evidence.some(
        (evidence) => evidence.sourceRecordId === lateFact.eventId,
      ),
      "a later run must see the appended fact",
    );

    const unrelatedPack = await builder.buildActivityPack({
      runId: "run:unrelated",
      projectId: unrelatedProjectId,
      profile: "quick",
      baselineDigest: "baseline:none",
      deadlineAt,
      eventNames: ["agent.response.observed"],
      maxFacts: 100,
    });
    assert.deepEqual(
      unrelatedPack.evidence.map((evidence) => evidence.origin.projectId),
      [unrelatedProjectId],
      "learning scopes must remain isolated",
    );
    const globalPack = await builder.buildActivityPack({
      runId: "run:global",
      projectId: EVOLUTION_GLOBAL_SCOPE_ID,
      profile: "standard",
      baselineDigest: "baseline:none",
      deadlineAt,
      eventNames: ["agent.response.observed"],
      maxFacts: 2,
    });
    assert.equal(globalPack.learningScope.scopeType, "global");
    assert.equal(globalPack.sources[0]?.recordCount, 5);
    assert.equal(globalPack.sources[0]?.truncated, false);
    assert.deepEqual(
      new Set(globalPack.evidence.map((evidence) => evidence.origin.projectId)),
      new Set([parentProjectId, childA, childB, unrelatedProjectId]),
      "global reflection must include every workspace while preserving each origin",
    );

    const paginationProjectId = "project:pagination";
    const paginationFacts = Array.from({ length: 51 }, (_, index) =>
      createFact(
        factory,
        paginationProjectId,
        `pagination-${index + 1}`,
        "/repo/pagination",
      ),
    );
    await activityStore.record(paginationFacts, Date.parse(capturedAt) + 2);
    const paginatedPack = await builder.buildActivityPack({
      runId: "run:pagination-page-1",
      projectId: paginationProjectId,
      profile: "standard",
      baselineDigest: "baseline:none",
      deadlineAt,
      eventNames: ["agent.response.observed"],
      maxFacts: 2,
    });
    assert.equal(paginatedPack.sources[0]?.recordCount, 51);
    assert.equal(paginatedPack.sources[0]?.truncated, false);
    assert.equal(
      paginatedPack.sources[0]?.processedThrough,
      paginatedPack.sources[0]?.snapshotBoundary,
      "one reflection must drain every page through the frozen boundary",
    );

    await evolutionStore.close();
    assert.equal(
      (await readFile(evolutionDatabasePath)).includes(
        Buffer.from(rawContentMarker),
      ),
      false,
      "learning.sqlite must not copy Activity raw content",
    );
    evolutionStore = await SqliteEvolutionActivationStore.create({
      databasePath: evolutionDatabasePath,
      env: {
        ...process.env,
        RUNWEAVE_BETTER_SQLITE3_NATIVE_BINDING: "",
        RUNWEAVE_BETTER_SQLITE3_PACKAGE_DIR: "",
        RUNWEAVE_EVOLUTION_WORKER_ENTRY: "",
      },
    });
    assert.deepEqual(
      await evolutionStore.getContextPackByRun(firstPack.runId),
      firstPack,
      "context pack manifest must survive learning store restart",
    );

    const temporaryRoot = path.join(tempRoot, "evolution", "tmp");
    const { orchestrator, service } = createAnalysisHarness({
      evolutionStore,
      activityStore,
      temporaryRoot,
    });
    const orphanedTemporaryDirectory = `${randomUUID()}-analyst_a-Ab12Cd`;
    const unrelatedTemporaryDirectory = "unowned-provider-temporary-data";
    await mkdir(path.join(temporaryRoot, orphanedTemporaryDirectory), {
      recursive: true,
    });
    await mkdir(path.join(temporaryRoot, unrelatedTemporaryDirectory), {
      recursive: true,
    });
    assert.equal(await orchestrator.cleanupOrphanedTemporaryDirectories(), 1);
    assert.deepEqual(
      await readdir(temporaryRoot),
      [unrelatedTemporaryDirectory],
      "recovery cleanup must ignore directories outside its strict ownership pattern",
    );
    await rm(path.join(temporaryRoot, unrelatedTemporaryDirectory), {
      recursive: true,
      force: true,
    });

    analysisFixtureState.currentEvidenceEventId = paginationFacts[0].eventId;
    const firstPaginatedRun = await executeRun({
      service,
      store: evolutionStore,
      orchestrator,
      projectId: paginationProjectId,
      budget: { maxContextBytes: 50_000 },
    });
    const firstPaginatedArtifacts = await service.getRunArtifacts(
      firstPaginatedRun.runId,
    );
    const firstPaginatedBoundary =
      firstPaginatedArtifacts.contextPack?.sources.find(
        (source) => source.source === "activity",
      );
    assert.equal(firstPaginatedBoundary?.truncated, false);
    assert.equal(firstPaginatedArtifacts.contextPack?.evidence.length, 51);
    assert.equal(
      (await evolutionStore.getWatermark(paginationProjectId, "activity"))
        ?.value,
      firstPaginatedBoundary?.snapshotBoundary,
      "knowledge commit must advance through the fully drained frozen range",
    );
    const emptyIncrementalRun = await executeRun({
      service,
      store: evolutionStore,
      orchestrator,
      projectId: paginationProjectId,
    });
    const emptyIncrementalArtifacts = await service.getRunArtifacts(
      emptyIncrementalRun.runId,
    );
    assert.equal(emptyIncrementalRun.stage, "no_material_novelty");
    assert.equal(emptyIncrementalArtifacts.contextPack?.evidence.length, 0);
    assert.equal(
      emptyIncrementalArtifacts.contextPack?.sources[0]?.afterWatermark,
      firstPaginatedBoundary?.snapshotBoundary,
    );

    analysisFixtureState.currentEvidenceEventId = initialFacts[0].eventId;
    const completedRun = await executeRun({
      service,
      store: evolutionStore,
      orchestrator,
      projectId: childA,
      dataRange: { afterWatermark: null },
    });
    assert.equal(completedRun.stage, "completed");
    const completedArtifacts = await service.getRunArtifacts(
      completedRun.runId,
    );
    const analystReports = completedArtifacts.reports.filter((report) =>
      report.role.startsWith("analyst_"),
    );
    assert.equal(analystReports.length, 2);
    assert.equal(completedArtifacts.attempts.length, 3);
    assert.ok(
      completedArtifacts.attempts.every(
        (attempt) => attempt.status === "completed" && attempt.reportId,
      ),
      "completed Provider attempts must link to immutable reports",
    );
    assert.ok(
      analystReports.every((report) => report.visibleReportIds.length === 0),
      "first-round analysts must not see each other's artifacts",
    );
    const crossReport = completedArtifacts.reports.find(
      (report) => report.role === "cross_examiner",
    );
    assert.deepEqual(
      new Set(crossReport?.visibleReportIds),
      new Set(analystReports.map((report) => report.reportId)),
    );
    assert.equal(completedArtifacts.claims[0]?.status, "corroborated");
    assert.equal(completedArtifacts.novelty[0]?.novelty, "novel");
    assert.equal(completedArtifacts.insightRevisions.length, 1);
    assert.equal(completedArtifacts.candidateIds.length, 1);

    const noNoveltyRun = await executeRun({
      service,
      store: evolutionStore,
      orchestrator,
      projectId: childB,
      dataRange: { afterWatermark: null },
    });
    assert.equal(noNoveltyRun.stage, "no_material_novelty");
    const noNoveltyArtifacts = await service.getRunArtifacts(
      noNoveltyRun.runId,
    );
    assert.equal(noNoveltyArtifacts.novelty[0]?.novelty, "known");
    assert.equal(noNoveltyArtifacts.insightRevisions.length, 0);
    assert.equal(noNoveltyArtifacts.candidateIds.length, 0);
    assert.deepEqual(await readdir(temporaryRoot), []);

    const reinforcementFact = createFact(
      factory,
      childA,
      "reinforcement",
      "/repo/browser-viewer/.worktree/agent-team-1",
    );
    await activityStore.record([reinforcementFact], Date.parse(capturedAt) + 2);
    analysisFixtureState.currentEvidenceEventId = reinforcementFact.eventId;
    const reinforcedRun = await executeRun({
      service,
      store: evolutionStore,
      orchestrator,
      projectId: childA,
      dataRange: { afterWatermark: null },
    });
    const reinforcedArtifacts = await service.getRunArtifacts(
      reinforcedRun.runId,
    );
    assert.equal(reinforcedArtifacts.novelty[0]?.novelty, "reinforced");
    assert.equal(reinforcedArtifacts.insightRevisions.length, 1);
    assert.equal(reinforcedArtifacts.candidateIds.length, 0);

    analysisFixtureState.currentStatement =
      "Code workers should inspect the scoped contract and its counterexamples before editing.";
    const contradictionRun = await executeRun({
      service,
      store: evolutionStore,
      orchestrator,
      projectId: childA,
      dataRange: { afterWatermark: null },
    });
    const contradictionArtifacts = await service.getRunArtifacts(
      contradictionRun.runId,
    );
    assert.equal(contradictionArtifacts.novelty[0]?.novelty, "contradiction");
    assert.equal(contradictionArtifacts.insightRevisions.length, 1);
    assert.equal(contradictionArtifacts.candidateIds.length, 1);

    analysisFixtureState.conflictingAnalysts = true;
    const contestedRun = await executeRun({
      service,
      store: evolutionStore,
      orchestrator,
      projectId: childA,
      dataRange: { afterWatermark: null },
    });
    const contestedArtifacts = await service.getRunArtifacts(
      contestedRun.runId,
    );
    assert.equal(contestedRun.stage, "no_material_novelty");
    assert.equal(contestedArtifacts.claims.length, 2);
    assert.ok(
      contestedArtifacts.claims.every((claim) => claim.status === "contested"),
    );
    assert.equal(contestedArtifacts.insightRevisions.length, 0);
    assert.equal(contestedArtifacts.candidateIds.length, 0);
    analysisFixtureState.conflictingAnalysts = false;

    analysisFixtureState.currentTopicKey = "drift.protocol-contract";
    analysisFixtureState.currentStatement =
      "Protocol revision one governs the scoped workflow.";
    const driftBaselineRun = await executeRun({
      service,
      store: evolutionStore,
      orchestrator,
      projectId: childA,
      dataRange: { afterWatermark: null },
    });
    assert.equal(driftBaselineRun.stage, "completed");
    analysisFixtureState.currentStatement =
      "Protocol revision two replaces revision one for the scoped workflow.";
    const driftRun = await executeRun({
      service,
      store: evolutionStore,
      orchestrator,
      projectId: childA,
      dataRange: { afterWatermark: null },
    });
    const driftArtifacts = await service.getRunArtifacts(driftRun.runId);
    assert.equal(driftArtifacts.novelty[0]?.novelty, "drift");
    assert.equal(driftArtifacts.insightRevisions.length, 1);

    const deletionProjectId = "project:evidence-deletion";
    const deletionFact = createFact(
      factory,
      deletionProjectId,
      "evidence-deletion",
      "/repo/evidence-deletion",
    );
    deletionFact.contents.push({
      contentId: randomUUID(),
      role: "response",
      mediaType: "text/plain; charset=utf-8",
      bytesBase64: Buffer.from("ephemeral-deletion-evidence").toString(
        "base64",
      ),
    });
    await activityStore.record([deletionFact], Date.parse(capturedAt) + 3);
    analysisFixtureState.currentEvidenceEventId = deletionFact.eventId;
    analysisFixtureState.currentTopicKey = "evidence-deletion-propagation";
    analysisFixtureState.currentStatement =
      "Evidence-dependent guidance must stop applying after its sole source is deleted.";
    const deletionRun = await executeRun({
      service,
      store: evolutionStore,
      orchestrator,
      projectId: deletionProjectId,
    });
    const deletionArtifacts = await service.getRunArtifacts(deletionRun.runId);
    const deletionInsight = deletionArtifacts.insightRevisions[0];
    assert.ok(deletionInsight);
    const deletionCandidate = (await evolutionStore.listCandidates()).find(
      (candidate) => candidate.insightRevisionId === deletionInsight.revisionId,
    );
    assert.equal(deletionCandidate?.lifecycle, "shadow");
    const deleteSnapshot = await activityStore.preview({
      projectId: deletionProjectId,
    });
    let deleteJob = await activityStore.createDeleteJob({
      requestId: randomUUID(),
      backendInstanceId: "evolution-analysis-verifier",
      authSubjectHmac: await activityStore.auditSubjectHmac(
        "evolution-analysis-verifier",
      ),
      scope: { projectId: deletionProjectId },
      snapshot: deleteSnapshot,
      nowMs: Date.parse(capturedAt) + 4,
    });
    while (deleteJob.status !== "completed") {
      deleteJob =
        (await activityStore.runDelete(
          "evolution-evidence-delete-owner",
          Date.parse(capturedAt) + 5,
        )) ?? deleteJob;
    }
    const reconciliation = await new EvolutionEvidenceReconciler(
      new ActivityQueryService(activityStore),
      evolutionStore,
      () => new Date(Date.parse(capturedAt) + 10 * 60_000),
    ).reconcile();
    assert.equal(reconciliation.revisedInsights, 1);
    assert.equal(reconciliation.revisedCandidates, 1);
    const reconciledInsight = await evolutionStore.getInsight(
      deletionInsight.insightId,
    );
    assert.notEqual(
      reconciledInsight?.currentRevisionId,
      deletionInsight.revisionId,
    );
    const reconciledDependency = (
      await evolutionStore.listEvidenceDependencies()
    ).find(
      (dependency) =>
        dependency.insight.insightId === deletionInsight.insightId,
    );
    assert.equal(reconciledDependency?.revision.confidence, 0);
    assert.ok(
      reconciledDependency?.contributionEdges.every(
        (edge) => edge.availability === "unavailable",
      ),
    );
    const retiredDeletionCandidate = (
      await evolutionStore.listCandidates()
    ).find((candidate) => candidate.assetId === deletionCandidate?.assetId);
    assert.equal(retiredDeletionCandidate?.lifecycle, "retired");

    await verifyFencedKnowledgeCommit(service, evolutionStore, childA);
    verifyProviderSelectionPolicies();
    await verifyNoveltyQualityGates();

    writeAnalysisVerificationResult(firstPack, secondPack);
  } finally {
    await activityStore.close();
    await evolutionStore.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

verifyAnalysisFoundation().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
