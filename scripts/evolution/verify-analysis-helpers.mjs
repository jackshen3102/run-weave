import assert from "node:assert/strict";
import { selectEvolutionProviders } from "../../backend/src/evolution/providers/selection.ts";
import { capturedAt } from "./verify-analysis-fixture.mjs";

export async function executeRun({
  service,
  store,
  orchestrator,
  projectId,
  budget,
  dataRange,
}) {
  const run = await service.createManualRun(
    {
      projectId,
      profile: "standard",
      providerPolicy: "auto",
      ...(budget ? { budget } : {}),
      ...(dataRange ? { dataRange } : {}),
    },
    "analysis-verifier",
  );
  const claim = await store.claimNextRun({
    ownerId: `verifier:${run.runId}`,
    now: capturedAt,
    leaseTtlMs: 60_000,
  });
  assert.ok(claim);
  await orchestrator.execute(
    claim,
    "http://127.0.0.1:49999",
    new AbortController().signal,
  );
  return service.getRun(run.runId);
}

export async function verifyFencedKnowledgeCommit(service, store, projectId) {
  const run = await service.createManualRun(
    { projectId, profile: "quick", providerPolicy: "codex" },
    "fencing-verifier",
  );
  const oldClaim = await store.claimNextRun({
    ownerId: "fencing-owner-old",
    now: capturedAt,
    leaseTtlMs: 1_000,
  });
  assert.ok(oldClaim);
  await advanceToValidating(store, oldClaim, capturedAt);
  await store.putRunAttempt({
    attemptId: `${run.runId}:old-provider-call`,
    runId: run.runId,
    attemptNumber: oldClaim.run.attempt,
    role: "analyst_a",
    provider: "codex",
    selectionReason: "explicit_policy",
    status: "running",
    startedAt: capturedAt,
    completedAt: null,
    errorCode: null,
    reportId: null,
  });
  const takeoverAt = new Date(Date.parse(capturedAt) + 2_000).toISOString();
  assert.equal(await store.recoverExpiredRuns(takeoverAt), 1);
  assert.equal(
    (await store.listRunAttempts(run.runId))[0]?.status,
    "abandoned",
  );
  const newClaim = await store.claimNextRun({
    ownerId: "fencing-owner-new",
    now: takeoverAt,
    leaseTtlMs: 60_000,
  });
  assert.ok(newClaim);
  await assert.rejects(
    store.commitRunKnowledge({
      runId: run.runId,
      ownerId: oldClaim.ownerId,
      fencingToken: oldClaim.fencingToken,
      now: takeoverAt,
      outcome: "no_material_novelty",
      insights: [],
      candidates: [],
      watermark: null,
    }),
    /evolution_(lease_lost|run_finalize_fence_mismatch)/,
  );
  await advanceToValidating(store, newClaim, takeoverAt);
  const finalized = await store.commitRunKnowledge({
    runId: run.runId,
    ownerId: newClaim.ownerId,
    fencingToken: newClaim.fencingToken,
    now: takeoverAt,
    outcome: "no_material_novelty",
    insights: [],
    candidates: [],
    watermark: null,
  });
  assert.equal(finalized.stage, "no_material_novelty");
}

async function advanceToValidating(store, claim, now) {
  const stages = [
    ["snapshotting", "segmenting"],
    ["segmenting", "independent_analysis"],
    ["independent_analysis", "cross_questioning"],
    ["cross_questioning", "novelty_check"],
    ["novelty_check", "validating"],
  ];
  for (const [expectedStage, nextStage] of stages) {
    await store.transitionRun({
      runId: claim.run.runId,
      ownerId: claim.ownerId,
      fencingToken: claim.fencingToken,
      expectedStage,
      nextStage,
      now,
    });
  }
}

export function verifyProviderSelectionPolicies() {
  const available = (names) =>
    ["codex", "trae"].map((provider) => ({
      provider,
      available: names.includes(provider),
      binaryAvailable: names.includes(provider),
      authenticated: names.includes(provider),
      version: names.includes(provider) ? "fake" : null,
      reason: names.includes(provider) ? null : "unavailable",
      checkedAt: capturedAt,
    }));
  assert.deepEqual(
    selectEvolutionProviders({
      policy: "auto",
      profile: "standard",
      availability: available(["codex", "trae"]),
    }),
    [
      { provider: "codex", selectionReason: "cross_provider" },
      { provider: "trae", selectionReason: "cross_provider" },
    ],
  );
  assert.deepEqual(
    selectEvolutionProviders({
      policy: "auto",
      profile: "standard",
      availability: available(["codex"]),
    }),
    [
      { provider: "codex", selectionReason: "fallback_single_provider" },
      { provider: "codex", selectionReason: "fallback_single_provider" },
    ],
  );
  assert.throws(
    () =>
      selectEvolutionProviders({
        policy: "mixed",
        profile: "standard",
        availability: available(["codex"]),
      }),
    /evolution_provider_mixed_unavailable/,
  );
  assert.throws(
    () =>
      selectEvolutionProviders({
        policy: "trae",
        profile: "quick",
        availability: available(["codex"]),
      }),
    /evolution_provider_trae_unavailable/,
  );
  assert.throws(
    () =>
      selectEvolutionProviders({
        policy: "auto",
        profile: "quick",
        availability: available([]),
      }),
    /evolution_provider_unavailable/,
  );
}

export function writeAnalysisVerificationResult(firstPack, secondPack) {
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        checks: [
          "parent-and-child-learning-scope",
          "historical-workspace-path-independent",
          "cross-scope-isolation",
          "activity-snapshot-high-watermark",
          "single-reflection-drains-frozen-range",
          "global-reflection-preserves-workspace-origins",
          "empty-incremental-reflection-is-valid-zero-output",
          "deadline-content-availability-frozen",
          "raw-content-not-copied",
          "context-pack-persistence",
          "queued-run-analysis-execution",
          "first-round-report-isolation",
          "cross-question-visible-artifacts",
          "claim-novelty-insight-candidate",
          "no-material-novelty-zero-output",
          "reinforced-insight-revision-without-candidate",
          "contradiction-insight-revision",
          "contested-claims-remain-separated",
          "dependency-drift-insight-revision",
          "activity-deletion-propagates-to-insight-and-candidate",
          "provider-temporary-files-cleaned",
          "orphaned-provider-temporary-files-recovered",
          "provider-attempt-audit-and-report-link",
          "knowledge-commit-fenced-and-atomic",
          "unknown-provider-attempt-abandoned-on-recovery",
          "provider-policy-selection-and-fallback",
        ],
        firstSnapshotBoundary: firstPack.sources[0]?.snapshotBoundary,
        firstPackEvidenceCount: firstPack.evidence.length,
        secondPackEvidenceCount: secondPack.evidence.length,
      },
      null,
      2,
    )}\n`,
  );
}
