import path from "node:path";
import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolveTerminalParentProjectId } from "../../packages/shared/src/terminal/project-context.ts";
import { EvolutionRepositoryScopes } from "../../backend/src/evolution/repository-scope.ts";
import { resolveRepositoryIdentity } from "../../backend/src/repository/identity.ts";
import { bindActivityRepositories } from "../../backend/src/activity/database/repository-index.ts";
const require = createRequire(
  new URL("../../backend/package.json", import.meta.url),
);
const Database = require("better-sqlite3");
let fixtureRepositoryRoot = null;
const repositoryPaths = new Map();
function repositoryPath(projectId) {
  const parent = resolveTerminalParentProjectId(projectId);
  if (!repositoryPaths.has(parent)) {
    const cwd = path.join(
      fixtureRepositoryRoot,
      createHash("sha256").update(parent).digest("hex").slice(0, 12),
    );
    mkdirSync(cwd, { recursive: true });
    execFileSync("git", ["init", cwd], { stdio: "ignore" });
    repositoryPaths.set(parent, cwd);
  }
  return repositoryPaths.get(parent);
}
import { ActivityEventFactory } from "../../backend/src/activity/recording/event-factory.ts";
import { randomUUID } from "node:crypto";
import { ActivityQueryService } from "../../backend/src/activity/database/service.ts";
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
      cwd: fixtureRepositoryRoot ? repositoryPath(projectId) : cwd,
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

export async function createAnalysisHarness({
  evolutionStore,
  activityStore,
  temporaryRoot,
}) {
  fixtureRepositoryRoot = path.join(
    path.dirname(temporaryRoot),
    "repositories",
  );
  const scopes = new EvolutionRepositoryScopes(
    evolutionStore,
    () => [],
    repositoryPath,
  );
  const activityDatabase = new Database(
    path.join(
      path.dirname(path.dirname(temporaryRoot)),
      "activity/activity.sqlite",
    ),
  );
  try {
    const facts = activityDatabase
      .prepare(
        "SELECT event_id,project_id FROM behavior_facts WHERE project_id IS NOT NULL",
      )
      .all();
    const bindings = [];
    for (const fact of facts) {
      const identity = await resolveRepositoryIdentity(
        repositoryPath(fact.project_id),
      );
      bindings.push({
        eventId: fact.event_id,
        repositoryId: identity.repositoryId,
        commonDirectory: identity.commonDirectory,
        reason: "owned_analysis_fixture_registration",
      });
    }
    bindActivityRepositories(activityDatabase, bindings);
  } finally {
    activityDatabase.close();
  }
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
    scopes,
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
