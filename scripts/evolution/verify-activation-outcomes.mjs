import assert from "node:assert/strict";
import { normalizeAgentTeamWorkerOutbox } from "../../backend/src/agent-team/outbox-resolver.ts";
import { InMemoryEvolutionActivationStore } from "../../backend/src/evolution/activation-store.ts";
import { EvolutionOutcomeObserver } from "../../backend/src/evolution/injection/outcome-observer.ts";
import { DefaultEvolutionMemoryProvider } from "../../backend/src/evolution/injection/memory-provider.ts";
import { createCandidateAssets } from "../../backend/src/evolution/knowledge/candidate-factory.ts";
import { authorizeMemoryCanary } from "../../backend/src/evolution/knowledge/lifecycle.ts";
import { StructuredEvolutionMemorySelector } from "../../backend/src/evolution/knowledge/retrieval.ts";
import { createEvolutionActivationRouter } from "../../backend/src/routes/evolution-activation.ts";
import { draft, enabledPolicy, now, query } from "./activation-fixture.mjs";

export async function verifyAssignmentAndOutcomes() {
  const store = new InMemoryEvolutionActivationStore();
  await store.putPolicy(enabledPolicy());
  const revA = authorizeMemoryCanary(
    createCandidateAssets([draft("memory", 30)], now)[0],
    enabledPolicy(),
    now,
  ).candidate;
  const revB = authorizeMemoryCanary(
    createCandidateAssets([draft("memory", 31)], now)[0],
    enabledPolicy(),
    now,
  ).candidate;
  await store.putCandidate(revA);
  const provider = new DefaultEvolutionMemoryProvider(
    store,
    new StructuredEvolutionMemorySelector(),
  );
  const first = await provider.prepare(query());
  await store.putCandidate(revB);
  const second = await provider.prepare(
    query({ dispatchId: "another-dispatch" }),
  );
  const firstRevAAssignment = first.trace.assignments.find(
    (item) => item.revisionId === revA.revisionId,
  );
  const secondRevAAssignment = second.trace.assignments.find(
    (item) => item.revisionId === revA.revisionId,
  );
  assert.ok(firstRevAAssignment);
  assert.deepEqual(secondRevAAssignment, firstRevAAssignment);
  assert.equal(
    first.trace.exposedRevisionIds.includes(revA.revisionId),
    second.trace.exposedRevisionIds.includes(revA.revisionId),
  );
  const revisedRevA = {
    ...revA,
    revisionId: `${revA.revisionId}-next`,
    guidance: `${revA.guidance} Updated revision.`,
    updatedAt: "2026-07-19T02:00:00.001Z",
  };
  await store.putCandidate(revisedRevA);
  const revised = await provider.prepare(
    query({ dispatchId: "revised-dispatch" }),
  );
  const revisedRevAAssignment = revised.trace.assignments.find(
    (item) => item.assetId === revA.assetId,
  );
  assert.ok(revisedRevAAssignment);
  assert.equal(revisedRevAAssignment.revisionId, revisedRevA.revisionId);
  assert.equal(revisedRevAAssignment.bucket, firstRevAAssignment.bucket);
  assert.equal(
    revisedRevAAssignment.assignmentHash,
    firstRevAAssignment.assignmentHash,
  );

  await store.putPolicy(
    enabledPolicy({ canaryRate: Number.EPSILON, revision: 2 }),
  );
  const control = await provider.prepare(query({ runId: "atr_control" }));
  assert.equal(control.trace.assignmentBucket, "control");
  assert.equal(control.context, null);
  assert.ok(control.trace.decisions.some((decision) => decision.selected));

  const observer = new EvolutionOutcomeObserver(store);
  assert.equal(
    await observer.recordAgentFeedbackForDispatch(
      control.trace.runId,
      control.trace.dispatchId,
      null,
    ),
    0,
  );
  const reviewMatches = await observer.recordForDispatch(
    first.trace.runId,
    second.trace.dispatchId,
    "review_gate",
    { sourceDispatchId: "review-for-second", status: "pass" },
  );
  assert.equal(reviewMatches, 1);
  const feedbackRevisionId = second.trace.exposedRevisionIds[0];
  assert.ok(feedbackRevisionId);
  const feedbackMatches = await observer.recordAgentFeedbackForDispatch(
    second.trace.runId,
    second.trace.dispatchId,
    {
      disposition: "adopted",
      assetRevisionIds: [feedbackRevisionId],
      summary: "Applied the exposed memory while implementing the task.",
    },
  );
  assert.equal(feedbackMatches, 1);
  assert.equal(
    await observer.recordAgentFeedbackForDispatch(
      second.trace.runId,
      second.trace.dispatchId,
      {
        disposition: "ignored",
        assetRevisionIds: ["not-exposed"],
        summary: "Must be rejected because this revision was not exposed.",
      },
    ),
    1,
  );
  await observer.recordForDispatch(
    first.trace.runId,
    first.trace.dispatchId,
    "behavior_gate",
    { status: "pass" },
  );
  await observer.recordForDispatch(
    first.trace.runId,
    first.trace.dispatchId,
    "user_correction",
    { count: 0 },
  );
  await observer.recordForDispatch(
    first.trace.runId,
    first.trace.dispatchId,
    "completed",
    { status: "done" },
  );
  const firstTrace = await store.getRuntimeTrace(first.trace.traceId);
  const secondTrace = await store.getRuntimeTrace(second.trace.traceId);
  assert.ok(firstTrace);
  assert.ok(secondTrace);
  assert.equal(
    firstTrace.events.some((event) => event.kind === "review_gate"),
    false,
  );
  assert.equal(
    firstTrace.events.some((event) => event.kind === "agent_feedback"),
    false,
  );
  assert.equal(
    secondTrace.events.filter((event) => event.kind === "review_gate").length,
    1,
  );
  assert.equal(
    secondTrace.events.filter((event) => event.kind === "agent_feedback")
      .length,
    2,
  );
  assert.equal(
    secondTrace.events.find(
      (event) =>
        event.kind === "agent_feedback" && event.detail.missing === true,
    )?.detail.disposition,
    "missing",
  );
  assert.ok(
    ["retrieved", "filtered", "selected", "assigned", "exposed"].every((kind) =>
      firstTrace.events.some((event) => event.kind === kind),
    ),
  );

  const normalized = normalizeAgentTeamWorkerOutbox({
    sessionId: "session-feedback",
    status: "completed",
    summary: "done",
    error: null,
    finishedAt: now,
    evolutionFeedback: {
      disposition: "conflicted",
      assetRevisionIds: [feedbackRevisionId, feedbackRevisionId],
      summary: "  Guidance conflicted with the task contract.  ",
    },
  });
  assert.deepEqual(normalized.evolutionFeedback, {
    disposition: "conflicted",
    assetRevisionIds: [feedbackRevisionId],
    summary: "Guidance conflicted with the task contract.",
  });
  assert.equal(
    normalizeAgentTeamWorkerOutbox({
      sessionId: "session-feedback",
      status: "completed",
      summary: "done",
      error: null,
      finishedAt: now,
      evolutionFeedback: {
        disposition: "adopted",
        assetRevisionIds: [],
        summary: "invalid",
      },
    }).evolutionFeedback,
    null,
  );
  const omittedFeedback = normalizeAgentTeamWorkerOutbox({
    sessionId: "session-feedback",
    status: "completed",
    summary: "done",
    error: null,
    finishedAt: now,
  });
  assert.ok(omittedFeedback);
  assert.equal(
    await observer.recordAgentFeedbackForDispatch(
      second.trace.runId,
      second.trace.dispatchId,
      omittedFeedback.evolutionFeedback ?? null,
    ),
    1,
  );
  const traceWithOmission = await store.getRuntimeTrace(second.trace.traceId);
  assert.equal(
    traceWithOmission.events.filter(
      (event) =>
        event.kind === "agent_feedback" && event.detail.missing === true,
    ).length,
    2,
  );

  const router = createEvolutionActivationRouter(store);
  const discoveryLayer = router.stack.find(
    (layer) => layer.route?.path === "/runtime-traces",
  );
  const discoveryHandler = discoveryLayer?.route?.stack.find(
    (layer) => layer.method === "get",
  )?.handle;
  assert.ok(discoveryHandler);
  let discoveryBody;
  let discoveryStatus = 200;
  const discoveryResponse = {
    setHeader() {},
    json(value) {
      discoveryBody = value;
    },
    status(value) {
      discoveryStatus = value;
      return discoveryResponse;
    },
  };
  await discoveryHandler(
    {
      query: {
        runId: second.trace.runId,
        dispatchId: second.trace.dispatchId,
      },
    },
    discoveryResponse,
  );
  assert.equal(discoveryStatus, 200);
  assert.deepEqual(
    discoveryBody.traces.map((trace) => trace.traceId),
    [second.trace.traceId],
  );

  discoveryBody = undefined;
  discoveryStatus = 200;
  await discoveryHandler(
    { query: { dispatchId: second.trace.dispatchId } },
    discoveryResponse,
  );
  assert.equal(discoveryStatus, 400);
  assert.equal(discoveryBody.error, "invalid_evolution_request");
}
