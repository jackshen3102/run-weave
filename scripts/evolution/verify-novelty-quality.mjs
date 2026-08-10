import assert from "node:assert/strict";
import { classifyClaimNovelty } from "../../backend/src/evolution/analysis/novelty-gate.ts";
import { EvolutionInsightService } from "../../backend/src/evolution/knowledge/insight-service.ts";

const createdAt = "2026-08-10T00:00:00.000Z";

export async function verifyNoveltyQualityGates() {
  const repository = evidence("repository:agents", "repository", {
    path: "/repo/AGENTS.md",
  });
  const synthetic = evidence("activity:dogfood", "activity", {
    path: "/tmp/runweave-evolution-dogfood-v1",
    eventName: "agent.response.observed",
    contentAvailable: true,
  });
  const unreadable = evidence("activity:unreadable", "activity", {
    path: "/repo",
    eventName: "agent.response.observed",
  });
  const readable = evidence("activity:readable", "activity", {
    path: "/repo",
    eventName: "agent.response.observed",
    contentAvailable: true,
  });
  const structured = evidence("activity:acceptance", "activity", {
    path: "/repo",
    eventName: "agent_team.case.result_recorded",
  });
  const secondReadable = evidence("activity:readable-2", "activity", {
    path: "/repo",
    eventName: "agent.response.observed",
    contentAvailable: true,
  });
  const thirdReadable = evidence("activity:readable-3", "activity", {
    path: "/repo",
    eventName: "agent.response.observed",
    contentAvailable: true,
  });
  const allEvidence = [
    repository,
    synthetic,
    unreadable,
    readable,
    structured,
    secondReadable,
    thirdReadable,
  ];

  const repositoryOnly = claim("claim:repository", {
    topicKey: "repository.rule",
    statement: "The repository requires scoped validation.",
    candidateType: "memory",
    evidenceIds: [repository.evidenceId],
  });
  const syntheticOnly = claim("claim:synthetic", {
    topicKey: "synthetic.rule",
    statement: "Dogfood fixtures should change runtime behavior.",
    candidateType: "memory",
    evidenceIds: [synthetic.evidenceId],
  });
  const unreadableRuntime = claim("claim:unreadable", {
    topicKey: "runtime.unreadable",
    statement: "Unreadable responses should become runtime guidance.",
    candidateType: "prompt",
    evidenceIds: [unreadable.evidenceId],
  });
  const productObservation = claim("claim:product", {
    topicKey: "product.retention",
    statement: "Activity response content is unavailable for analysis.",
    candidateType: "product",
    evidenceIds: [unreadable.evidenceId],
  });
  const structuredRuntime = claim("claim:structured", {
    topicKey: "routing.acceptance",
    statement: "Acceptance failures should route to code repair.",
    candidateType: "routing",
    evidenceIds: [structured.evidenceId],
  });
  const duplicateWeak = claim("claim:duplicate-weak", {
    topicKey: "docs.testing.preread",
    statement:
      "Code workers editing docs/testing should read the test plan format first.",
    candidateType: "memory",
    evidenceIds: [readable.evidenceId],
  });
  const duplicateStrong = claim("claim:duplicate-strong", {
    topicKey: "repository.testing.protocol",
    statement:
      "Code workers editing docs/testing must read the test plan format before acting.",
    candidateType: "memory",
    evidenceIds: [readable.evidenceId, secondReadable.evidenceId],
  });
  const crossLanguageRetentionWeak = claim("claim:retention-english", {
    topicKey: "content-retention-limits-analysis-depth",
    statement:
      "Expired activity content limits post-hoc evaluation of user intent and agent outcomes.",
    candidateType: "product",
    evidenceIds: [readable.evidenceId, unreadable.evidenceId],
  });
  const crossLanguageRetentionStrong = claim("claim:retention-chinese", {
    topicKey: "retain-evaluation-content",
    statement: "应让用于演化分析的请求、响应和关键工具内容至少保留到分析完成。",
    candidateType: "product",
    evidenceIds: [
      readable.evidenceId,
      unreadable.evidenceId,
      thirdReadable.evidenceId,
    ],
  });
  const sharedEvidenceDifferentTopic = claim("claim:acceptance-quality", {
    topicKey: "acceptance-review-quality-gates",
    statement: "Acceptance reviews should preserve actionable failure details.",
    candidateType: "product",
    evidenceIds: [
      readable.evidenceId,
      unreadable.evidenceId,
      thirdReadable.evidenceId,
    ],
  });

  const classified = classifyClaimNovelty(
    [
      repositoryOnly,
      syntheticOnly,
      unreadableRuntime,
      productObservation,
      structuredRuntime,
      duplicateWeak,
      duplicateStrong,
      crossLanguageRetentionWeak,
      crossLanguageRetentionStrong,
      sharedEvidenceDifferentTopic,
    ],
    [],
    allEvidence,
  );
  assertNovelty(classified, repositoryOnly.claimId, "known", "repository_baseline_only");
  assertNovelty(classified, syntheticOnly.claimId, "known", "synthetic_evidence_only");
  assertNovelty(
    classified,
    unreadableRuntime.claimId,
    "known",
    "runtime_candidate_lacks_readable_behavior_evidence",
  );
  assertNovelty(classified, productObservation.claimId, "novel");
  assertNovelty(classified, structuredRuntime.claimId, "novel");
  assertNovelty(
    classified,
    duplicateWeak.claimId,
    "known",
    "semantically_duplicate_claim_in_same_run",
  );
  assertNovelty(classified, duplicateStrong.claimId, "novel");
  assertNovelty(
    classified,
    crossLanguageRetentionWeak.claimId,
    "known",
    "semantically_duplicate_claim_in_same_run",
  );
  assertNovelty(classified, crossLanguageRetentionStrong.claimId, "novel");
  assertNovelty(classified, sharedEvidenceDifferentTopic.claimId, "novel");

  const baseline = insight("insight:baseline", {
    topicKey: "existing.testing.protocol",
    statement:
      "Code workers editing docs/testing must read the test plan format before acting.",
    evidenceIds: [readable.evidenceId],
  });
  const semanticReinforcement = claim("claim:semantic-reinforcement", {
    topicKey: "renamed.testing.protocol",
    statement:
      "Code workers editing docs/testing must read the test plan format before acting.",
    candidateType: "memory",
    evidenceIds: [readable.evidenceId, secondReadable.evidenceId],
  });
  const semanticNovelty = classifyClaimNovelty(
    [semanticReinforcement],
    [baseline],
    allEvidence,
  );
  assertNovelty(
    semanticNovelty,
    semanticReinforcement.claimId,
    "reinforced",
    "semantically_matching_insight_has_new_supporting_evidence",
  );
  const prepared = await new EvolutionInsightService({
    listInsights: async () => [baseline],
  }).prepare({
    runId: "run:semantic-reinforcement",
    learningScopeId: baseline.learningScopeId,
    claims: [semanticReinforcement],
    novelty: semanticNovelty,
    createdAt,
  });
  assert.equal(prepared.insights[0]?.insight.insightId, baseline.insightId);
  assert.equal(prepared.insights[0]?.insight.topicKey, baseline.topicKey);

  const crossLanguageBaseline = insight("insight:retention-baseline", {
    topicKey: "content-retention-limits-analysis-depth",
    statement:
      "Expired activity content limits post-hoc evaluation of user intent and agent outcomes.",
    evidenceIds: [readable.evidenceId, unreadable.evidenceId],
  });
  const crossLanguageReinforcement = claim(
    "claim:retention-cross-language-reinforcement",
    {
      topicKey: "retain-evaluation-content",
      statement: "应让用于演化分析的请求、响应和关键工具内容至少保留到分析完成。",
      candidateType: "product",
      evidenceIds: [
        readable.evidenceId,
        unreadable.evidenceId,
        thirdReadable.evidenceId,
      ],
    },
  );
  const crossLanguageNovelty = classifyClaimNovelty(
    [crossLanguageReinforcement],
    [crossLanguageBaseline],
    allEvidence,
  );
  assertNovelty(
    crossLanguageNovelty,
    crossLanguageReinforcement.claimId,
    "reinforced",
    "semantically_matching_insight_has_new_supporting_evidence",
  );
  const crossLanguagePrepared = await new EvolutionInsightService({
    listInsights: async () => [crossLanguageBaseline],
  }).prepare({
    runId: "run:cross-language-reinforcement",
    learningScopeId: crossLanguageBaseline.learningScopeId,
    claims: [crossLanguageReinforcement],
    novelty: crossLanguageNovelty,
    createdAt,
  });
  assert.equal(
    crossLanguagePrepared.insights[0]?.insight.insightId,
    crossLanguageBaseline.insightId,
  );
  assert.equal(
    crossLanguagePrepared.insights[0]?.insight.topicKey,
    crossLanguageBaseline.topicKey,
  );
}

function evidence(
  evidenceId,
  source,
  { path, eventName = null, contentAvailable = false },
) {
  return {
    evidenceId,
    source,
    sourceRecordId: evidenceId,
    digest: `digest:${evidenceId}`,
    availability: "available",
    activity:
      source === "activity"
        ? {
            activityOffset: 1,
            eventName,
            occurredAt: createdAt,
            producerName: "verifier",
            actorType: "agent",
            runtimeSurface: "backend",
            resultStatus: null,
            resultCode: null,
            payload: {},
          }
        : null,
    origin: {
      projectId: "project:verifier",
      path,
      branch: null,
      revision: null,
    },
    relationships: {
      terminalSessionId: null,
      threadId: null,
      runId: null,
      interactionId: null,
      correlationId: null,
      causationId: null,
      parentEventId: null,
    },
    contentRefs: contentAvailable
      ? [
          {
            contentId: `content:${evidenceId}`,
            sha256: `sha:${evidenceId}`,
            availability: "available",
            expectedExpiresAt: "2026-08-11T00:00:00.000Z",
            unavailableReason: null,
          },
        ]
      : [],
  };
}

function claim(
  claimId,
  { topicKey, statement, candidateType, evidenceIds },
) {
  return {
    claimId,
    runId: "run:verifier",
    learningScopeId: "project:verifier",
    topicKey,
    statement,
    scope: "verification scope",
    status: "corroborated",
    supportingEvidenceIds: evidenceIds,
    counterEvidenceIds: [],
    reportIds: ["report:a", "report:b"],
    missingEvidence: [],
    candidateType,
    guidance: "Apply only when the evidence contract is satisfied.",
    risk: "low",
    createdAt,
  };
}

function insight(insightId, { topicKey, statement, evidenceIds }) {
  const revisionId = `${insightId}:revision`;
  return {
    insightId,
    learningScopeId: "project:verifier",
    topicKey,
    currentRevisionId: revisionId,
    createdAt,
    updatedAt: createdAt,
    revisions: [
      {
        revisionId,
        insightId,
        runId: "run:baseline",
        statement,
        scope: "verification scope",
        confidence: 0.85,
        novelty: "novel",
        claimIds: ["claim:baseline"],
        evidenceIds,
        counterEvidenceIds: [],
        createdAt,
      },
    ],
  };
}

function assertNovelty(items, claimId, novelty, rationale) {
  const item = items.find((candidate) => candidate.claimId === claimId);
  assert.equal(item?.novelty, novelty);
  if (rationale) assert.equal(item?.rationale, rationale);
}
