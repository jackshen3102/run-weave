import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildWorkerStartupPrompt } from "../../backend/src/agent-team/prompt-builders.ts";
import { InMemoryEvolutionActivationStore } from "../../backend/src/evolution/activation-store.ts";
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
import { StructuredEvolutionMemorySelector } from "../../backend/src/evolution/knowledge/retrieval.ts";
import { DefaultEvolutionMemoryProvider } from "../../backend/src/evolution/injection/memory-provider.ts";
import { SqliteEvolutionActivationStore } from "../../backend/src/evolution/storage/store.ts";
import {
  draft,
  enabledPolicy,
  now,
  prepareActivationFixture,
  query,
  scope,
} from "./activation-fixture.mjs";
import { verifyAssignmentAndOutcomes } from "./verify-activation-outcomes.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
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

async function verifyRetrievalAndInjection() {
  const { store, canaries } = await prepareActivationFixture();
  const seenBySelector = [];
  const baseSelector = new StructuredEvolutionMemorySelector();
  const selector = {
    version: baseSelector.version,
    async select(input, candidates) {
      seenBySelector.push(
        ...candidates.map((candidate) => candidate.revisionId),
      );
      return baseSelector.select(input, candidates);
    },
  };
  const provider = new DefaultEvolutionMemoryProvider(store, selector);
  const result = await provider.prepare(query());
  assert.equal(result.trace.assignmentBucket, "canary");
  assert.ok(
    result.context?.startsWith(
      '<evolution-context status="canary" advisory="true">',
    ),
  );
  assert.ok(result.context?.includes("assetId:"));
  assert.ok(result.context?.includes("evidenceGrade:"));
  assert.ok(result.context?.includes("guidance:"));
  assert.ok(result.trace.exposedRevisionIds.length <= 3);
  assert.ok(new TextEncoder().encode(result.context).byteLength <= 6_000);
  assert.deepEqual(
    new Set(seenBySelector),
    new Set(canaries.map((item) => item.revisionId)),
  );
  assert.ok(
    result.trace.filtered.some(
      (item) => item.reason === "learning_scope_mismatch",
    ),
  );
  assert.ok(
    result.trace.filtered.some(
      (item) => item.reason === "worker_role_mismatch",
    ),
  );
  assert.ok(
    result.trace.filtered.some(
      (item) => item.reason === "lifecycle_not_injectable",
    ),
  );
  assert.ok(result.trace.filtered.some((item) => item.reason === "expired"));
  assert.ok(
    result.trace.filtered.some((item) => item.reason === "task_exclusion"),
  );
  assert.ok(result.trace.decisions.every((decision) => decision.reason));

  const run = JSON.parse(
    await readFile(
      path.join(root, ".runweave/agent-team/atr_dd8353fe_20260719020754.json"),
      "utf8",
    ),
  );
  const worker = run.workers.find((item) => item.role === "code");
  const baseline = buildWorkerStartupPrompt({
    run,
    worker,
    acceptance: run.acceptance,
    outboxPath: ".runweave/outbox/verifier.json",
  });
  const injected = buildWorkerStartupPrompt({
    run,
    worker,
    acceptance: run.acceptance,
    outboxPath: ".runweave/outbox/verifier.json",
    evolutionContext: result.context,
  });
  assert.equal(
    injected.replace(
      `\n\n${result.context}\n\n- 若使用了 Evolution Context，outbox 顶层必须填写 evolutionFeedback: { disposition: "adopted"|"ignored"|"conflicted", assetRevisionIds: string[], summary: string }；只填写实际暴露的 revision，反馈仅作观察，不单独决定效果。`,
      "",
    ),
    baseline,
    "Evolution context and its feedback contract must be append-only prompt blocks",
  );

  const nonCode = await provider.prepare(query({ workerRole: "code_review" }));
  assert.equal(nonCode.context, null);
  assert.equal(nonCode.trace.assignmentBucket, "not_eligible");

  const failingStore = {
    ...store,
    getPolicy: async () => {
      throw new Error("learning_db_unavailable");
    },
    putRuntimeTrace: async () => {},
  };
  const failed = await new DefaultEvolutionMemoryProvider(
    failingStore,
    baseSelector,
  ).prepare(query());
  assert.equal(failed.context, null);
  assert.equal(failed.trace.failOpenReason, "learning_db_unavailable");
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
  const store = new InMemoryEvolutionActivationStore();
  const memory = createCandidateAssets([draft("memory", 50)], now)[0];
  await store.putCandidate(memory);
  const provider = new DefaultEvolutionMemoryProvider(
    store,
    new StructuredEvolutionMemorySelector(),
  );
  const disabled = await provider.prepare(query());
  assert.equal(disabled.trace.assignmentBucket, "disabled");
  assert.equal(disabled.context, null);
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
  const store = new InMemoryEvolutionActivationStore();
  await store.putPolicy(enabledPolicy());
  await store.putCandidate(drifted.candidate);
  const noInjection = await new DefaultEvolutionMemoryProvider(
    store,
    new StructuredEvolutionMemorySelector(),
  ).prepare(query({ dependencies: { protocolRevision: "v2" } }));
  assert.equal(noInjection.context, null);
  assert.ok(
    noInjection.trace.filtered.some(
      (item) => item.reason === "lifecycle_not_injectable",
    ),
  );
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
    const provider = new DefaultEvolutionMemoryProvider(
      store,
      new StructuredEvolutionMemorySelector(),
    );
    const result = await provider.prepare(query({ runId: "atr_persistent" }));
    await store.close();

    store = await SqliteEvolutionActivationStore.create({ databasePath });
    const candidates = await store.listCandidates();
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].revisionId, canary.revisionId);
    assert.equal((await store.getPolicy(scope)).revision, 1);
    assert.equal(
      (await store.getRuntimeTrace(result.trace.traceId)).assignmentBucket,
      "canary",
    );
    await store.close();
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await verifyCandidateGovernance();
await verifyRetrievalAndInjection();
await verifyAssignmentAndOutcomes();
await verifyPromotionPolicy();
await verifyDefaultAndScopePolicy();
await verifyDriftAndRollback();
await verifyPersistentAuditStore();

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    cases: [
      "ASEA-001",
      "ASEA-002",
      "ASEA-003",
      "ASEA-004",
      "ASEA-005",
      "ASEA-006",
      "ASEA-007",
    ],
  })}\n`,
);
