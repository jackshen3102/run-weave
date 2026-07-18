import { normalizeAgentTeamWorkerOutbox } from "../../backend/src/agent-team/outbox-resolver.ts";
import {
  resolvePendingFindingDecision,
  resolveRepairTargets,
  reviewFindingContractErrors,
} from "../../backend/src/agent-team/repair-loop.ts";
import { buildRepairEvidence } from "./repair-fixtures.mjs";

export function verifyFindingDispositionChecks(check, { run, reviewOutbox }) {
  const finalReviewTarget = {
    scope: "final",
    baseCommit: "base",
    targetTree: "target-tree",
    changedPaths: ["backend/src/agent-team/repair-loop.ts"],
    planSha256: "plan-sha",
    testCaseSha256: "case-sha",
    requestedAt: "2026-07-14T00:00:15.000Z",
  };
  const finalRun = {
    ...run,
    acceptance: [
      {
        ...run.acceptance[0],
        caseId: "case_1",
        sourceCaseId: "AGT-RUNTIME-001",
        sourceFilePath: "docs/testing/repair.testplan.yaml",
        status: "pass",
      },
      run.acceptance[1],
    ],
    activeWorkerDispatch: {
      role: "code_review",
      panelId: "review-panel",
      tmuxPaneId: "%2",
      round: 2,
      requestedAt: finalReviewTarget.requestedAt,
      outboxMtimeMs: 1,
      reviewTarget: finalReviewTarget,
    },
  };
  const finalReviewOutbox = normalizeAgentTeamWorkerOutbox({
    ...reviewOutbox,
    reviewTarget: finalReviewTarget,
    remainingFindings: [
      {
        ...reviewOutbox.remainingFindings[0],
        caseImpacts: [
          {
            caseId: "case_1",
            summary: "the reproduced transition violates the product case",
            evidence: [buildRepairEvidence("case-impact")],
          },
        ],
      },
    ],
  });
  check(
    "repair-final-review-blocker-maps-traceable-product-case",
    reviewFindingContractErrors(
      finalRun,
      finalReviewOutbox,
      finalReviewOutbox.acceptanceResults,
    ).length === 0 &&
      resolvePendingFindingDecision(finalRun, finalReviewOutbox) === null &&
      resolveRepairTargets(
        finalRun,
        finalReviewOutbox,
        finalReviewOutbox.acceptanceResults,
      )[0]?.caseIds.join(",") === "case_1",
    finalReviewOutbox,
  );
  const unmappedFinalOutbox = normalizeAgentTeamWorkerOutbox({
    ...finalReviewOutbox,
    remainingFindings: [
      {
        ...finalReviewOutbox.remainingFindings[0],
        caseImpacts: undefined,
      },
    ],
  });
  check(
    "repair-final-review-unmapped-finding-pauses-for-human",
    resolvePendingFindingDecision(
      finalRun,
      unmappedFinalOutbox,
    )?.reason.includes("可追溯产品 Case") === true,
    unmappedFinalOutbox,
  );
  const genericGateMappedOutbox = normalizeAgentTeamWorkerOutbox({
    ...finalReviewOutbox,
    remainingFindings: [
      {
        ...finalReviewOutbox.remainingFindings[0],
        caseImpacts: [
          {
            caseId: "case_2",
            summary: "generic review gate",
            evidence: [buildRepairEvidence("generic-gate")],
          },
        ],
      },
    ],
  });
  check(
    "repair-final-review-generic-gate-is-not-product-traceability",
    resolvePendingFindingDecision(finalRun, genericGateMappedOutbox) !== null,
    genericGateMappedOutbox,
  );
  const proposedOutOfScopeOutbox = normalizeAgentTeamWorkerOutbox({
    ...finalReviewOutbox,
    remainingFindings: [
      {
        ...finalReviewOutbox.remainingFindings[0],
        disposition: "out_of_scope",
      },
    ],
  });
  check(
    "repair-reviewer-out-of-scope-proposal-requires-human",
    resolvePendingFindingDecision(finalRun, proposedOutOfScopeOutbox) !== null,
    proposedOutOfScopeOutbox,
  );
  const dispositionedFinalRun = {
    ...finalRun,
    findingDecisions: [
      {
        id: "finding-decision-1",
        invariantKey: "checkpoint.index-ownership",
        scenarioId: "review-finding-reproduction",
        finding: proposedOutOfScopeOutbox.remainingFindings[0],
        disposition: "out_of_scope",
        caseIds: [],
        reason: "manual relaunch is not a supported product scenario",
        decidedAt: "2026-07-14T00:00:30.000Z",
        reviewTarget: finalReviewTarget,
      },
    ],
  };
  check(
    "repair-human-disposition-keeps-finding-but-removes-blocker",
    resolvePendingFindingDecision(
      dispositionedFinalRun,
      proposedOutOfScopeOutbox,
    ) === null &&
      proposedOutOfScopeOutbox.remainingFindings.length === 1 &&
      resolveRepairTargets(
        dispositionedFinalRun,
        proposedOutOfScopeOutbox,
        proposedOutOfScopeOutbox.acceptanceResults,
      ).length === 0,
    dispositionedFinalRun.findingDecisions,
  );
}
