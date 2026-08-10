import { ActivityEventFactory } from "../../backend/src/activity/event-factory.ts";
import { randomUUID } from "node:crypto";
import { ActivityQueryService } from "../../backend/src/activity/query-service.ts";
import { EvolutionAnalysisOrchestrator } from "../../backend/src/evolution/analysis/orchestrator.ts";
import { EvolutionContextPackBuilder } from "../../backend/src/evolution/context-pack.ts";
import { EvolutionService } from "../../backend/src/evolution/service.ts";
import { EvolutionToolTokenRegistry } from "../../backend/src/evolution/tools/token-registry.ts";

export const capturedAt = "2026-07-25T01:00:00.000Z";
export const deadlineAt = "2026-07-25T02:00:00.000Z";
export const rawContentMarker =
  "activity-raw-content-must-not-enter-learning-db";

export const analysisFixtureState = {
  currentEvidenceEventId: "",
  currentTopicKey: "read-protocol-first",
  currentStatement:
    "Code workers in this scope should read the protocol before editing.",
  conflictingAnalysts: false,
};

class FakeAnalysisProvider {
  constructor(provider) {
    this.provider = provider;
  }

  async run(request) {
    const evidenceId =
      "activity:" + analysisFixtureState.currentEvidenceEventId;
    if (request.prompt.includes('phase="cross_questioning"')) {
      return {
        provider: this.provider,
        durationMs: 1,
        events: [],
        output: {
          reviews: [
            {
              topicKey: analysisFixtureState.currentTopicKey,
              status: analysisFixtureState.conflictingAnalysts
                ? "contested"
                : "corroborated",
              counterEvidenceIds: [],
              missingEvidence: [],
              rationale: "Both independent reports cite the frozen fact.",
            },
          ],
        },
      };
    }
    return {
      provider: this.provider,
      durationMs: 1,
      events: [],
      output: {
        summary: `${this.provider} independent analysis`,
        observedFacts: [
          {
            statement: "The task requires consulting the protocol first.",
            evidenceIds: [evidenceId],
          },
        ],
        assessments: [
          {
            dimension: "action_quality",
            value: "positive",
            evidenceIds: [evidenceId],
            rationale: "The frozen fact directly supports the observation.",
          },
        ],
        claims: [
          {
            topicKey: analysisFixtureState.currentTopicKey,
            statement:
              analysisFixtureState.conflictingAnalysts &&
              request.prompt.includes('role="analyst_b"')
                ? `${analysisFixtureState.currentStatement} Alternative cause remains plausible.`
                : analysisFixtureState.currentStatement,
            scope: "Agent Team code work in the learning scope",
            supportingEvidenceIds: [evidenceId],
            counterEvidenceIds: [],
            candidateType: "memory",
            guidance: "Read the protocol before editing scoped files.",
            risk: "low",
          },
        ],
      },
    };
  }
}

export function createFactory(instanceId) {
  return new ActivityEventFactory({
    producerName: "evolution-analysis-verifier",
    producerVersion: "1",
    producerInstanceId: instanceId,
    runtimeChannel: "dev",
    runtimeSurface: "backend",
    sourceRevision: `revision:${instanceId}`,
  });
}

export function createFact(factory, projectId, label, cwd) {
  const event = factory.create({
    eventName: "agent.response.observed",
    occurredAt: capturedAt,
    actorType: "agent",
    actorAgent: "codex",
    scope: {
      projectId,
      cwd,
      threadId: `thread:${label}`,
      runId: `agent-team:${label}`,
    },
    payload: { label },
  });
  event.contents.push({
    contentId: randomUUID(),
    role: "response",
    mediaType: "text/plain; charset=utf-8",
    bytesBase64: Buffer.from(`response:${label}`).toString("base64"),
  });
  return event;
}

export function createAnalysisHarness({
  evolutionStore,
  activityStore,
  temporaryRoot,
}) {
  const analysisNow = () => new Date(capturedAt);
  const service = new EvolutionService(
    evolutionStore,
    analysisNow,
    {
      list: async () =>
        ["codex", "trae"].map((provider) => ({
          provider,
          available: true,
          binaryAvailable: true,
          authenticated: true,
          version: "fake",
          reason: null,
          checkedAt: capturedAt,
        })),
    },
    evolutionStore,
    evolutionStore,
    evolutionStore,
  );
  const orchestrator = new EvolutionAnalysisOrchestrator(
    evolutionStore,
    evolutionStore,
    new EvolutionContextPackBuilder(
      new ActivityQueryService(activityStore),
      evolutionStore,
      analysisNow,
    ),
    new EvolutionToolTokenRegistry(),
    { list: () => service.listProviders() },
    temporaryRoot,
    {
      codex: new FakeAnalysisProvider("codex"),
      trae: new FakeAnalysisProvider("trae"),
    },
    analysisNow,
  );
  return { orchestrator, service };
}
