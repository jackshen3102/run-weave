import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCandidateAssets } from "../../backend/src/evolution/knowledge/candidate-factory.ts";
import {
  applyManualPromotionOverride,
  authorizeMemoryCanary,
  defaultEvolutionScopePolicy,
  evaluateAutomaticPromotion,
  evaluateDependencyDrift,
  retireCandidate,
  validateEvolutionScopePolicy,
} from "../../backend/src/evolution/knowledge/lifecycle.ts";
import { SqliteEvolutionActivationStore } from "../../backend/src/evolution/storage/store.ts";
import {
  draft,
  enabledPolicy,
  now,
  scope,
} from "./activation-fixture.mjs";

async function verifyCandidateGovernance() {
  const types = ["memory", "prompt", "skill", "routing", "product", "code"];
  const candidates = createCandidateAssets(
    types.map((type) => draft(type)),
    now,
  );
  assert.deepEqual(
    candidates.map((candidate) => candidate.type),
    types,
  );
  for (const candidate of candidates) {
    assert.ok(candidate.insightRevisionId);
    assert.ok(candidate.evidenceRefs.length > 0);
    assert.ok(candidate.counterEvidenceRefs.length > 0);
    assert.ok(candidate.applicability.workerRoles.length > 0);
    assert.ok(candidate.generatorVersion);
    const decision = authorizeMemoryCanary(candidate, enabledPolicy(), now);
    assert.equal(decision.changed, candidate.type === "memory");
  }
}

async function verifyPromotionPolicy() {
  const memory = createCandidateAssets([draft("memory", 40)], now)[0];
  const canary = authorizeMemoryCanary(memory, enabledPolicy(), now).candidate;
  const autoPolicy = enabledPolicy({
    autoPromotion: true,
    minimumPromotionGrade: "E4",
    minimumPromotionSamples: 3,
  });
  for (const grade of ["E1", "E2"]) {
    const result = evaluateAutomaticPromotion(canary, autoPolicy, {
      grade,
      sampleCount: 100,
      objectiveImprovement: true,
      criticalRegressionCount: 0,
      evidenceRefs: ["model-review"],
    });
    assert.equal(result.changed, false);
  }
  const lowSample = evaluateAutomaticPromotion(canary, autoPolicy, {
    grade: "E4",
    sampleCount: 2,
    objectiveImprovement: true,
    criticalRegressionCount: 0,
    evidenceRefs: ["live-canary"],
  });
  assert.equal(lowSample.changed, false);
  const promoted = evaluateAutomaticPromotion(canary, autoPolicy, {
    grade: "E4",
    sampleCount: 3,
    objectiveImprovement: true,
    criticalRegressionCount: 0,
    evidenceRefs: ["live-canary"],
  });
  assert.equal(promoted.candidate.lifecycle, "promoted");
  const regressed = evaluateAutomaticPromotion(canary, autoPolicy, {
    grade: "E4",
    sampleCount: 3,
    objectiveImprovement: true,
    criticalRegressionCount: 1,
    evidenceRefs: ["safety-regression"],
  });
  assert.equal(regressed.candidate.lifecycle, "retired");
  const unaudited = applyManualPromotionOverride(canary, {
    actor: "",
    reason: "",
    evidenceRefs: [],
  });
  assert.equal(unaudited.changed, false);
  const overridden = applyManualPromotionOverride(canary, {
    actor: "scope-owner",
    reason: "Reviewed E4 evidence",
    evidenceRefs: ["approval-1"],
  });
  assert.equal(overridden.candidate.lifecycle, "promoted");
  assert.equal(overridden.override.previousRevisionId, canary.revisionId);
  assert.equal(
    overridden.candidate.lifecycleHistory.at(-1).actor,
    "scope-owner",
  );
  assert.deepEqual(overridden.candidate.lifecycleHistory.at(-1).evidenceRefs, [
    "approval-1",
  ]);
}

async function verifyDefaultAndScopePolicy() {
  assert.throws(() =>
    validateEvolutionScopePolicy({
      ...enabledPolicy(),
      maxInjectedAssets: 4,
    }),
  );
  assert.throws(() =>
    validateEvolutionScopePolicy({
      ...defaultEvolutionScopePolicy(scope, now),
      canaryRate: 0.5,
    }),
  );
  const code = createCandidateAssets([draft("code", 51)], now)[0];
  assert.equal(authorizeMemoryCanary(code, enabledPolicy()).changed, false);
}

async function verifyDriftAndRollback() {
  const memory = createCandidateAssets([draft("memory", 60)], now)[0];
  const canary = authorizeMemoryCanary(memory, enabledPolicy(), now).candidate;
  const promoted = applyManualPromotionOverride(canary, {
    actor: "scope-owner",
    reason: "dogfood complete",
    evidenceRefs: ["e4-trace"],
  }).candidate;
  const unchanged = evaluateDependencyDrift(promoted, {
    protocolRevision: "v1",
    sourceRevision: "unrelated-file-change",
  });
  assert.equal(unchanged.changed, false);
  const drifted = evaluateDependencyDrift(promoted, {
    protocolRevision: "v2",
  });
  assert.equal(drifted.candidate.lifecycle, "needs_revalidation");
  const retired = retireCandidate(drifted.candidate, "owner rollback");
  assert.equal(retired.candidate.lifecycle, "retired");
  assert.notEqual(retired.candidate.revisionId, drifted.candidate.revisionId);
}

async function verifyPersistentAuditStore() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "rw-evolution-"));
  const databasePath = path.join(temporaryRoot, "learning.sqlite");
  try {
    let store = await SqliteEvolutionActivationStore.create({ databasePath });
    const memory = createCandidateAssets([draft("memory", 70)], now)[0];
    const canary = authorizeMemoryCanary(
      memory,
      enabledPolicy(),
      now,
    ).candidate;
    await store.putCandidate(memory);
    await store.putCandidate(canary);
    await store.putPolicy(enabledPolicy());
    await store.close();

    store = await SqliteEvolutionActivationStore.create({ databasePath });
    const candidates = await store.listCandidates();
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].revisionId, canary.revisionId);
    assert.equal((await store.getPolicy(scope)).revision, 1);
    await store.close();
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await verifyCandidateGovernance();
await verifyPromotionPolicy();
await verifyDefaultAndScopePolicy();
await verifyDriftAndRollback();
await verifyPersistentAuditStore();

process.stdout.write(`${JSON.stringify({ ok: true, checks: ["candidate_governance", "promotion_policy", "scope_policy", "drift_and_rollback", "persistent_audit_store"] })}\n`);
