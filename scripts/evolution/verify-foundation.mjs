import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { EVOLUTION_GLOBAL_SCOPE_ID } from "../../packages/shared/src/evolution.ts";
import { buildTerminalChildProjectId } from "../../packages/shared/src/terminal/project-context.ts";
import { createEvolutionMcpRouter } from "../../backend/src/routes/evolution-mcp.ts";
import { EvolutionService } from "../../backend/src/evolution/service.ts";
import { EvolutionProviderAvailabilityService } from "../../backend/src/evolution/providers/availability.ts";
import { SqliteEvolutionActivationStore } from "../../backend/src/evolution/storage/store.ts";
import { EvolutionToolTokenRegistry } from "../../backend/src/evolution/tools/token-registry.ts";
import { verifyProviderProcessBoundary } from "./verify-provider-process-boundary.mjs";

const backendRequire = createRequire(
  new URL("../../backend/package.json", import.meta.url),
);
const express = backendRequire("express");
const { Client } = backendRequire("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = backendRequire(
  "@modelcontextprotocol/sdk/client/streamableHttp.js",
);
const initialTime = Date.parse("2026-07-25T00:00:00.000Z");

function verifyToolTokenBoundary() {
  const registry = new EvolutionToolTokenRegistry();
  const now = new Date(initialTime);
  const issued = registry.issue({
    runId: "run-token-fixture",
    attemptId: "attempt-token-fixture",
    analystRole: "analyst-a",
    allowedTools: ["context.describe", "context.describe"],
    ttlMs: 1_000,
    now,
  });
  assert.deepEqual(issued.grant.allowedTools, ["context.describe"]);
  assert.equal(registry.resolve(issued.token, now)?.runId, "run-token-fixture");
  assert.equal(
    registry.resolve(issued.token, new Date(initialTime + 1_000)),
    null,
  );
  const revoked = registry.issue({
    runId: "run-token-fixture",
    attemptId: "attempt-revoked",
    analystRole: "analyst-b",
    allowedTools: ["context.describe"],
    ttlMs: 1_000,
    now,
  });
  registry.revokeAttempt("attempt-revoked");
  assert.equal(registry.resolve(revoked.token, now), null);
}

async function verifyMcpBoundary() {
  const registry = new EvolutionToolTokenRegistry();
  const manifest = {
    schemaVersion: 1,
    contextPackId: "context-pack:run-mcp-fixture",
    runId: "run-mcp-fixture",
    learningScope: {
      learningScopeId: "project:mcp-fixture",
      requestedProjectId: "project:mcp-fixture",
      projectSelector: {
        exactProjectId: "project:mcp-fixture",
        childProjectIdPrefix: "project:mcp-fixture:terminal:",
      },
    },
    profile: "quick",
    baselineDigest: "baseline-fixture",
    createdAt: new Date(initialTime).toISOString(),
    deadlineAt: new Date(initialTime + 60_000).toISOString(),
    digest: "context-fixture",
    sources: [
      {
        sourceId: "activity",
        source: "activity",
        afterWatermark: "0",
        snapshotBoundary: "2",
        processedThrough: "2",
        digest: "activity-fixture",
        recordCount: 2,
        truncated: false,
      },
    ],
    evidence: [
      activityEvidenceFixture({
        evidenceId: "activity:fixture-success",
        activityOffset: 1,
        eventName: "terminal.command.completed",
        occurredAt: "2026-07-25T00:00:01.000Z",
        path: "/workspace/one",
        status: "succeeded",
        code: "0",
        payload: { exitCode: 0 },
      }),
      activityEvidenceFixture({
        evidenceId: "activity:fixture-failure",
        activityOffset: 2,
        eventName: "terminal.command.completed",
        occurredAt: "2026-07-25T00:00:02.000Z",
        path: "/workspace/two",
        status: "failed",
        code: "1",
        payload: { exitCode: 1 },
      }),
    ],
    dataQualityIssues: Array.from({ length: 2_500 }, (_, index) => ({
      issueId: `quality-${index}`,
      source: "activity",
      code: "activity_content_expired",
      severity: "warning",
      detail: "Activity content is unavailable for the frozen run.",
      evidenceIds: [
        index % 2 === 0
          ? "activity:fixture-success"
          : "activity:fixture-failure",
      ],
    })),
  };
  const app = express();
  app.use(express.json());
  app.use(
    "/internal/evolution/mcp",
    createEvolutionMcpRouter({
      contextPackStore: {
        putContextPack: async () => undefined,
        getContextPack: async () => manifest,
        getContextPackByRun: async (runId) =>
          runId === manifest.runId ? manifest : null,
      },
      tokenRegistry: registry,
    }),
  );
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const endpoint = new URL(
      `http://127.0.0.1:${address.port}/internal/evolution/mcp`,
    );
    const issued = registry.issue({
      runId: manifest.runId,
      attemptId: "attempt-mcp-fixture",
      analystRole: "analyst-a",
      allowedTools: ["context.describe", "activity.summarize_facts"],
      ttlMs: 60_000,
    });
    const client = new Client({ name: "foundation-verifier", version: "1.0" });
    await client.connect(
      new StreamableHTTPClientTransport(endpoint, {
        requestInit: {
          headers: { Authorization: `Bearer ${issued.token}` },
        },
      }),
    );
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      ["context.describe", "activity.summarize_facts"],
    );
    const result = await client.callTool({
      name: "context.describe",
      arguments: {},
    });
    const description = JSON.parse(result.content[0].text);
    assert.equal(description.runId, manifest.runId);
    assert.equal(description.analystRole, "analyst-a");
    assert.equal(description.dataQuality.issueCount, 2_500);
    assert.equal(description.dataQuality.groups.length, 1);
    assert.ok(result.content[0].text.length < 10_000);
    const summaryResult = await client.callTool({
      name: "activity.summarize_facts",
      arguments: {},
    });
    const summary = JSON.parse(summaryResult.content[0].text);
    assert.equal(summary.coverage.recordCount, 2);
    assert.equal(summary.coverage.summarizedCount, 2);
    assert.equal(summary.coverage.fullyCovered, true);
    assert.equal(summary.coverage.workspaceCount, 2);
    assert.equal(summary.failureCodes[0].code, "1");
    assert.equal(summary.failureCodes[0].count, 1);
    await client.close();

    registry.revokeAttempt("attempt-mcp-fixture");
    const rejected = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${issued.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    assert.equal(rejected.status, 401);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function activityEvidenceFixture(input) {
  return {
    evidenceId: input.evidenceId,
    source: "activity",
    sourceRecordId: input.evidenceId.slice("activity:".length),
    digest: `digest:${input.evidenceId}`,
    availability: "available",
    activity: {
      activityOffset: input.activityOffset,
      eventName: input.eventName,
      occurredAt: input.occurredAt,
      producerName: "foundation-verifier",
      actorType: "agent",
      runtimeSurface: "shell",
      resultStatus: input.status,
      resultCode: input.code,
      payload: input.payload,
    },
    origin: {
      projectId: "project:mcp-fixture",
      path: input.path,
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
    contentRefs: [],
  };
}

function fixtureRun(overrides) {
  const createdAt = overrides.createdAt;
  return {
    runId: overrides.runId,
    learningScopeId: overrides.learningScopeId,
    trigger: overrides.trigger,
    profile: "standard",
    providerPolicy: "auto",
    budget: {
      maxAgents: 2,
      maxModelTurns: 10,
      maxWallTimeMs: 1_200_000,
      maxContextBytes: 1_000_000,
      maxToolCalls: 60,
      maxReplays: 0,
    },
    dataRange: {
      afterWatermark: null,
      atOrBefore: createdAt,
    },
    stage: "queued",
    outcome: null,
    createdAt,
    updatedAt: createdAt,
    startedAt: null,
    completedAt: null,
    attempt: 0,
  };
}

async function verifyFoundation() {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "runweave-evolution-foundation-"),
  );
  const databasePath = path.join(tempRoot, "learning.sqlite");
  const stores = [];
  try {
    verifyToolTokenBoundary();
    await verifyMcpBoundary();
    await verifyProviderProcessBoundary(tempRoot);
    for (let index = 0; index < 3; index += 1) {
      stores.push(
        await SqliteEvolutionActivationStore.create({ databasePath }),
      );
    }

    let clockMs = initialTime + 1_000;
    const service = new EvolutionService(
      stores[0],
      () => new Date(clockMs),
      new EvolutionProviderAvailabilityService({
        RUNWEAVE_CODEX_BIN: path.join(tempRoot, "missing-codex"),
        RUNWEAVE_TRAE_BIN: path.join(tempRoot, "missing-trae"),
      }),
    );
    const parentProjectId = "project:browser-viewer";
    const childProjectId = buildTerminalChildProjectId(
      parentProjectId,
      "agent-team-2",
    );

    await stores[0].createRun(
      fixtureRun({
        runId: "10000000-0000-4000-8000-000000000001",
        learningScopeId: parentProjectId,
        trigger: {
          type: "schedule",
          scheduleId: "20000000-0000-4000-8000-000000000001",
          dueAt: new Date(initialTime).toISOString(),
        },
        createdAt: new Date(initialTime).toISOString(),
      }),
    );
    const manualRun = await service.createManualRun(
      { projectId: childProjectId },
      "foundation-verifier",
    );
    assert.equal(manualRun.learningScopeId, parentProjectId);

    const firstClaims = await Promise.all(
      stores.map((store, index) =>
        store.claimNextRun({
          ownerId: `backend-${index}`,
          now: new Date(clockMs).toISOString(),
          leaseTtlMs: 1_000,
        }),
      ),
    );
    const firstClaim = firstClaims.find((claim) => claim !== null);
    assert.ok(firstClaim);
    assert.equal(
      firstClaims.filter((claim) => claim !== null).length,
      1,
      "only one backend may claim the global run lease",
    );
    assert.equal(
      firstClaim.run.runId,
      manualRun.runId,
      "manual runs must outrank older scheduled runs",
    );

    clockMs += 2_000;
    assert.equal(
      await stores[1].recoverExpiredRuns(new Date(clockMs).toISOString()),
      1,
    );
    const secondClaims = await Promise.all(
      stores.map((store, index) =>
        store.claimNextRun({
          ownerId: `recovery-backend-${index}`,
          now: new Date(clockMs).toISOString(),
          leaseTtlMs: 10_000,
        }),
      ),
    );
    const recoveredClaim = secondClaims.find((claim) => claim !== null);
    assert.ok(recoveredClaim);
    assert.equal(secondClaims.filter((claim) => claim !== null).length, 1);
    assert.equal(recoveredClaim.run.runId, manualRun.runId);
    assert.ok(recoveredClaim.fencingToken > firstClaim.fencingToken);

    await assert.rejects(
      stores[0].transitionRun({
        runId: manualRun.runId,
        ownerId: firstClaim.ownerId,
        fencingToken: firstClaim.fencingToken,
        expectedStage: "snapshotting",
        nextStage: "segmenting",
        now: new Date(clockMs).toISOString(),
      }),
      /evolution_lease_lost/,
    );

    const heartbeatExpiry = await stores[0].heartbeatRunClaim({
      ownerId: recoveredClaim.ownerId,
      fencingToken: recoveredClaim.fencingToken,
      now: new Date(clockMs).toISOString(),
      leaseTtlMs: 20_000,
    });
    assert.ok(Date.parse(heartbeatExpiry) > clockMs);

    const stages = [
      ["snapshotting", "segmenting"],
      ["segmenting", "independent_analysis"],
      ["independent_analysis", "cross_questioning"],
      ["cross_questioning", "novelty_check"],
      ["novelty_check", "validating"],
    ];
    for (const [expectedStage, nextStage] of stages) {
      await stores[0].transitionRun({
        runId: manualRun.runId,
        ownerId: recoveredClaim.ownerId,
        fencingToken: recoveredClaim.fencingToken,
        expectedStage,
        nextStage,
        now: new Date(clockMs).toISOString(),
      });
    }

    const watermark = {
      learningScopeId: parentProjectId,
      source: "activity",
      value: "offset:42",
      runId: manualRun.runId,
      updatedAt: new Date(clockMs).toISOString(),
    };
    await stores[0].putWatermark({
      watermark,
      ownerId: recoveredClaim.ownerId,
      fencingToken: recoveredClaim.fencingToken,
      now: new Date(clockMs).toISOString(),
    });
    await stores[0].transitionRun({
      runId: manualRun.runId,
      ownerId: recoveredClaim.ownerId,
      fencingToken: recoveredClaim.fencingToken,
      expectedStage: "validating",
      nextStage: "completed",
      now: new Date(clockMs).toISOString(),
    });
    assert.equal((await service.getRun(manualRun.runId))?.stage, "completed");

    const scheduledClaim = await stores[1].claimNextRun({
      ownerId: "schedule-backend",
      now: new Date(clockMs).toISOString(),
      leaseTtlMs: 10_000,
    });
    assert.equal(scheduledClaim?.run.trigger.type, "schedule");
    await service.cancelRun(scheduledClaim.run.runId);
    const incrementalManualRun = await service.createManualRun(
      { scope: { type: "project", projectId: childProjectId } },
      "foundation-verifier",
    );
    assert.equal(incrementalManualRun.learningScopeId, parentProjectId);
    assert.equal(
      incrementalManualRun.dataRange.afterWatermark,
      "offset:42",
      "one-click manual reflection must start after the last successful watermark",
    );
    await service.cancelRun(incrementalManualRun.runId);
    const globalManualRun = await service.createManualRun(
      { scope: { type: "global" } },
      "foundation-verifier",
    );
    assert.equal(globalManualRun.learningScopeId, EVOLUTION_GLOBAL_SCOPE_ID);
    assert.equal(globalManualRun.dataRange.afterWatermark, null);
    await service.cancelRun(globalManualRun.runId);

    const schedule = await service.createSchedule({
      projectId: childProjectId,
      name: "Weekly reflection",
      cronExpression: "0 10 * * 1",
      timezone: "Asia/Shanghai",
    });
    assert.equal(schedule.learningScopeId, parentProjectId);
    assert.ok(schedule.nextDueAt);
    await assert.rejects(
      service.createSchedule({
        projectId: childProjectId,
        name: "Invalid",
        cronExpression: "not a cron",
        timezone: "Asia/Shanghai",
      }),
      /evolution_schedule_cron_invalid/,
    );
    clockMs += 1_000;
    const updatedSchedule = await service.updateSchedule(schedule.scheduleId, {
      enabled: false,
      name: "Paused weekly reflection",
    });
    assert.equal(updatedSchedule.enabled, false);
    assert.equal((await service.listSchedules(parentProjectId)).length, 1);

    const catchUpSchedule = await service.createSchedule({
      projectId: childProjectId,
      name: "Catch-up reflection",
      cronExpression: "* * * * *",
      timezone: "UTC",
    });
    clockMs += 185_000;
    const schedulerServices = stores.map(
      (store) => new EvolutionService(store, () => new Date(clockMs)),
    );
    const materialized = (
      await Promise.all(
        schedulerServices.map((schedulerService) =>
          schedulerService.materializeDueSchedules(),
        ),
      )
    ).flat();
    assert.equal(
      materialized.length,
      1,
      "competing schedulers must materialize one catch-up run",
    );
    const materializedSchedule = await stores[0].getSchedule(
      catchUpSchedule.scheduleId,
    );
    assert.ok(materializedSchedule);
    assert.equal(
      materializedSchedule.lastDueAt,
      new Date("2026-07-25T00:03:00.000Z").toISOString(),
      "catch-up must retain only the latest missed dueAt",
    );
    assert.ok(Date.parse(materializedSchedule.nextDueAt) > clockMs);
    assert.equal(
      (await stores[0].getRun(materializedSchedule.lastRunId)).dataRange
        .afterWatermark,
      "offset:42",
    );

    const providers = await service.listProviders();
    assert.equal(providers.length, 2);
    assert.ok(
      providers.every(
        (provider) =>
          !provider.available &&
          provider.reason === "provider_binary_not_found",
      ),
    );

    const retried = await service.retryRun(
      manualRun.runId,
      "foundation-verifier",
    );
    assert.equal(retried.stage, "queued");
    assert.equal(retried.learningScopeId, parentProjectId);

    await Promise.all(stores.splice(0).map((store) => store.close()));
    const reopened = await SqliteEvolutionActivationStore.create({
      databasePath,
    });
    stores.push(reopened);
    assert.equal((await reopened.getRun(manualRun.runId))?.stage, "completed");
    assert.deepEqual(
      await reopened.getWatermark(parentProjectId, "activity"),
      watermark,
    );
    assert.equal(
      (await reopened.getSchedule(schedule.scheduleId))?.name,
      "Paused weekly reflection",
    );
  } finally {
    await Promise.all(stores.splice(0).map((store) => store.close()));
    await rm(tempRoot, { recursive: true, force: true });
  }
}

verifyFoundation()
  .then(() => {
    console.log("Evolution foundation verification passed.");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
