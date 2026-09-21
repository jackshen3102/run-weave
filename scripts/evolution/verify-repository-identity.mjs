// Integration rehearsal: real Git repositories, SQLite workers, frozen packs and migrations.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, stat, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { verifyRepositoryEntrypoints } from "./verify-repository-fixtures.mjs";
import { verifyRepositoryStartup } from "./verify-repository-startup.mjs";
import { ActivityStore } from "../../backend/src/activity/recording/store.ts";
import { ActivityEventFactory } from "../../backend/src/activity/recording/event-factory.ts";
import { ActivityQueryService } from "../../backend/src/activity/database/service.ts";
import { EvolutionActivationDatabase } from "../../backend/src/evolution/storage/database.ts";
import { SqliteEvolutionActivationStore } from "../../backend/src/evolution/storage/store.ts";
import { EvolutionRepositoryScopes } from "../../backend/src/evolution/repository-scope.ts";
import { EvolutionService } from "../../backend/src/evolution/service.ts";
import { EvolutionContextPackBuilder } from "../../backend/src/evolution/context-pack.ts";
import { createCandidateAsset } from "../../backend/src/evolution/knowledge/candidate-factory.ts";
import { defaultEvolutionScopePolicy } from "../../backend/src/evolution/knowledge/lifecycle.ts";
import {
  auditRepositoryMigration,
  fingerprint,
  openReadOnly,
} from "../../backend/src/evolution/storage/repository-migration-audit.ts";
import {
  applyRepositoryMigration,
  rollbackRepositoryMigration,
  verifyRepositoryMigration,
  privateJson,
} from "../../backend/src/evolution/storage/repository-migration-apply.ts";
import { resumeMigratedSchedules } from "../../backend/src/evolution/storage/repository-migration-schedules.ts";
import { bindActivityRepositories } from "../../backend/src/activity/database/repository-index.ts";
import { ACTIVITY_EVENT_NAMES } from "../../packages/shared/src/activity/index.ts";

const require = createRequire(
  new URL("../../backend/package.json", import.meta.url),
);
const Database = require("better-sqlite3");
const root = await mkdtemp(
  path.join(os.tmpdir(), "runweave-repository-integration-"),
);
const results = [];
const passed = (id, detail) => {
  results.push({ id, detail });
  console.log(JSON.stringify({ passed: id, detail }));
};
const env = {
  ...process.env,
  RUNWEAVE_ACTIVITY_WORKER_ENTRY: "",
  RUNWEAVE_EVOLUTION_WORKER_ENTRY: "",
  RUNWEAVE_ACTIVITY_TEST_MODE: "true",
};
// Strip inherited Git variables instead of using empty overrides.
for (const key of [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
])
  delete process.env[key];
let activity, store;
try {
  const { repo, other, worktree, plain, identity, id, otherId } =
    await verifyRepositoryEntrypoints(root, passed);

  const data = path.join(root, "data"),
    activityFile = path.join(data, "activity/activity.sqlite"),
    evolutionFile = path.join(data, "evolution/learning.sqlite");
  activity = await ActivityStore.create({ databasePath: activityFile, env });
  store = await SqliteEvolutionActivationStore.create({
    databasePath: evolutionFile,
    env,
  });
  const projects = [
    { id: "legacy-a", name: "A", path: repo },
    { id: "legacy-b", name: "B", path: worktree },
    { id: "legacy-other", name: "Other", path: other },
  ];
  const scopes = new EvolutionRepositoryScopes(
    store,
    () => projects,
    (id) => projects.find((p) => p.id === id)?.path ?? null,
  );
  const query = new ActivityQueryService(activity);
  const boundary = async (repoId) =>
    (
      await query.evolutionSnapshot({
        learningScopeId: repoId,
        afterWatermark: 0,
        eventNames: [...ACTIVITY_EVENT_NAMES],
        limit: 1,
      })
    ).snapshotBoundary;
  const service = new EvolutionService(
    store,
    undefined,
    undefined,
    store,
    store,
    store,
    scopes,
    boundary,
  );
  const a = await service.createManualRun({ projectId: "legacy-a" }, "fixture");
  const b = await service.createManualRun({ projectId: "legacy-b" }, "fixture");
  assert.equal(a.learningScopeId, b.learningScopeId);
  assert.equal((await service.listRuns({ learningScopeId: id })).length, 2);
  await service.cancelRun(a.runId);
  await service.cancelRun(b.runId);
  await assert.rejects(
    service.createManualRun({ scope: { type: "global" } }, "fixture"),
    /global_requires_reflection_batch/,
  );
  const batch = await service.createReflectionBatch(randomUUID(), "fixture");
  assert.deepEqual(batch.repositoryIds.sort(), [id, otherId].sort());
  assert.deepEqual(
    await service.createReflectionBatch(batch.idempotencyKey, "fixture"),
    batch,
  );
  for (const runId of batch.runIds) await service.cancelRun(runId);
  passed(
    "live-service",
    "Project compatibility produces one repository; batch creation is persisted and idempotent",
  );

  const factory = new ActivityEventFactory({
    producerName: "repository-integration",
    producerVersion: "1",
    producerInstanceId: randomUUID(),
    runtimeChannel: "dev",
    runtimeSurface: "backend",
  });
  const facts = [];
  for (const [session, cwd] of [
    ["session-a", repo],
    ["session-b", other],
  ])
    facts.push(
      factory.create({
        eventName: "terminal.session.created",
        scope: { projectId: "same-project", terminalSessionId: session, cwd },
        payload: {},
      }),
    );
  for (const [session, cwd] of [
    ["session-a", repo],
    ["session-a", worktree],
    ["session-b", other],
    ["unresolved", plain],
  ])
    facts.push(
      factory.create({
        eventName: "agent.tool.completed",
        scope: { projectId: "same-project", terminalSessionId: session, cwd },
        payload: { toolName: "fixture" },
      }),
    );
  assert.ok(
    (await activity.record(facts)).every((ack) => ack.status === "committed"),
  );
  const snap = await query.evolutionSnapshot({
    learningScopeId: id,
    afterWatermark: 0,
    eventNames: [...ACTIVITY_EVENT_NAMES],
    limit: 1,
  });
  assert.ok(snap.hasMore);
  assert.ok(snap.unresolvedRepositoryCount >= 1);
  const db = new Database(activityFile);
  const unresolved = facts.at(-1);
  bindActivityRepositories(db, [
    {
      eventId: unresolved.eventId,
      repositoryId: id,
      commonDirectory: identity.commonDirectory,
      reason: "fixture_verified_binding",
    },
  ]);
  db.close();
  const frozen = await query.evolutionSnapshot({
    learningScopeId: id,
    afterWatermark: snap.nextWatermark,
    atOrBeforeSnapshotBoundary: snap.snapshotBoundary,
    eventNames: [...ACTIVITY_EVENT_NAMES],
    limit: 100,
  });
  assert.ok(!frozen.facts.some((f) => f.eventId === unresolved.eventId));
  const backfill = await query.evolutionSnapshot({
    learningScopeId: id,
    afterWatermark: snap.snapshotBoundary,
    eventNames: [...ACTIVITY_EVENT_NAMES],
    limit: 100,
  });
  assert.deepEqual(
    backfill.facts.map((f) => f.eventId),
    [unresolved.eventId],
  );
  const builder = new EvolutionContextPackBuilder(query, store);
  const pack = await builder.buildActivityPack({
    runId: randomUUID(),
    projectId: id,
    repository: { repositoryId: id, cwd: repo },
    profile: "quick",
    baselineDigest: "fixture",
    deadlineAt: new Date(Date.now() + 60000).toISOString(),
  });
  assert.ok(
    !pack.evidence.some((e) => e.evidenceId === `activity:${facts[4].eventId}`),
  );
  passed(
    "freeze-backfill",
    "Repository snapshot excludes another repository and late attribution is outside the frozen cursor but in the next backfill",
  );

  const abort = new AbortController();
  const readSnapshot = query.evolutionSnapshot.bind(query);
  query.evolutionSnapshot = async (input) => {
    const page = await readSnapshot(input);
    abort.abort(new Error("fixture_snapshot_cancelled"));
    return page;
  };
  const cancelledPackId = randomUUID();
  try {
    await assert.rejects(
      builder.buildActivityPack({
        runId: cancelledPackId,
        projectId: id,
        repository: { repositoryId: id, cwd: repo },
        profile: "quick",
        baselineDigest: "fixture",
        deadlineAt: new Date(Date.now() + 60000).toISOString(),
        maxFacts: 1,
        signal: abort.signal,
      }),
      /fixture_snapshot_cancelled/,
    );
    assert.equal(await store.getContextPackByRun(cancelledPackId), null);
  } finally {
    query.evolutionSnapshot = readSnapshot;
  }
  passed(
    "snapshot-cancellation",
    "Cancellation after a real SQLite page prevents further paging and persists no incomplete Pack",
  );

  // Seed old heads/revisions using real persistence; then remove only the additive
  // v6 schema in this owned fixture to exercise the v5 migration contract.
  const now = new Date().toISOString();
  const runIds = [];
  for (const scope of ["legacy-a", "legacy-b"]) {
    const runId = randomUUID();
    runIds.push(runId);
    await store.createRun({
      ...a,
      runId,
      learningScopeId: scope,
      repository: undefined,
      stage: "completed",
      outcome: "completed",
      completedAt: now,
    });
    await store.putContextPack({
      ...pack,
      contextPackId: `fixture:${runId}`,
      runId,
      learningScope: {
        scopeType: "project",
        learningScopeId: scope,
        requestedProjectId: scope,
        projectSelector: {
          exactProjectId: scope,
          childProjectIdPrefix: scope + ":",
        },
      },
      evidence: [
        ...(scope === "legacy-a"
          ? [
              {
                ...pack.evidence[0],
                evidenceId: "repository:fixture",
                source: "repository",
                origin: {
                  ...pack.evidence[0].origin,
                  path: path.join(repo, "AGENTS.md"),
                },
              },
            ]
          : []),
        pack.evidence.find(
          (e) => e.evidenceId === `activity:${facts[2].eventId}`,
        ),
      ],
    });
    for (const topic of ["same", "conflict"]) {
      const insightId = `${scope}:${topic}`,
        revisionId = `rev:${insightId}`,
        statement =
          topic === "same"
            ? "same conclusion"
            : `${scope} competing conclusion`,
        evidenceIds = [`activity:${facts[2].eventId}`];
      const revision = {
        revisionId,
        insightId,
        runId,
        statement,
        scope: "fixture",
        confidence: 0.8,
        novelty: "novel",
        claimIds: [],
        evidenceIds,
        counterEvidenceIds: [],
        createdAt: now,
      };
      await store.putInsightRevision({
        insight: {
          insightId,
          learningScopeId: scope,
          topicKey: topic,
          currentRevisionId: revisionId,
          createdAt: now,
          updatedAt: now,
        },
        revision,
        contributionEdges: [],
      });
      const candidate = createCandidateAsset(
        {
          type: "memory",
          learningScopeId: scope,
          insightRevisionId: revisionId,
          statement,
          guidance: statement,
          rationale: "fixture",
          evidenceRefs: evidenceIds,
          counterEvidenceRefs: [],
          applicability: { workerRoles: ["code"] },
          risk: "low",
        },
        now,
      );
      candidate.lifecycle = scope === "legacy-a" ? "canary" : "retired";
      await store.putCandidate(candidate);
    }
    const schedule = await service.createSchedule({
      scope: { type: "repository", cwd: repo },
      name: scope,
      cronExpression: "0 * * * *",
      timezone: "UTC",
      enabled: true,
    });
    await store.putSchedule({
      ...schedule,
      learningScopeId: scope,
      repository: undefined,
      lastRunId: runId,
    });
    await store.putPolicy({
      ...defaultEvolutionScopePolicy(scope),
      memoryCanaryEnabled: true,
      canaryRate: 1,
    });
  }
  await store.close();
  store = null;
  await activity.close();
  activity = null;
  const old = new Database(evolutionFile);
  old.exec(
    "DELETE FROM evolution_metadata WHERE key='repositoryMigrationState'; UPDATE evolution_metadata SET value='5' WHERE key='schemaVersion'; UPDATE evolution_metadata SET value='1' WHERE key='minimumWriterVersion'; ALTER TABLE evolution_runs DROP COLUMN repository_json;",
  );
  for (const scope of ["legacy-a", "legacy-b"])
    old
      .prepare("INSERT INTO evolution_watermarks VALUES (?,?,?,?,?)")
      .run(scope, "activity", "9999", runIds[0], Date.parse(now));
  for (const table of [
    "evolution_repositories",
    "evolution_repository_bindings",
    "evolution_topic_lineage",
    "evolution_reflection_batches",
    "evolution_repository_migrations",
  ])
    old.exec(`DROP TABLE ${table}`);
  old.close();
  // A committed WAL transaction survives abrupt owner exit and is included in audit/backup.
  const walProbe = spawnSync(
    process.execPath,
    [
      "-e",
      `const D=require(${JSON.stringify(require.resolve("better-sqlite3"))});const d=new D(${JSON.stringify(evolutionFile)});d.pragma('journal_mode=WAL');d.pragma('wal_autocheckpoint=0');d.prepare("UPDATE evolution_runs SET updated_at_ms=updated_at_ms+1 WHERE run_id=?").run(${JSON.stringify(a.runId)});process.exit(0)`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(walProbe.status, 0, walProbe.stderr);
  assert.ok((await stat(evolutionFile + "-wal")).size > 0);
  let manifest = await auditRepositoryMigration(data);
  const busy = new Database(evolutionFile);
  await assert.rejects(
    applyRepositoryMigration(manifest, data),
    /migration_database_busy/,
  );
  busy
    .prepare(
      "UPDATE evolution_runs SET updated_at_ms=updated_at_ms+1 WHERE run_id=?",
    )
    .run(a.runId);
  busy.close();
  await assert.rejects(
    applyRepositoryMigration(manifest, data),
    /migration_input_changed/,
  );
  manifest = await auditRepositoryMigration(data);
  passed(
    "offline-drift-wal",
    "A live SQLite owner and a stale manifest both block apply; committed WAL data survives into the audited source",
  );
  assert.equal(manifest.insightMoves.length, 4);
  assert.equal(manifest.candidateMoves.length, 4);
  await privateJson(path.join(root, "manifest.json"), manifest);
  await applyRepositoryMigration(manifest, data);
  verifyRepositoryMigration(manifest, data);
  assert.equal(
    (await applyRepositoryMigration(manifest, data)).phase,
    "complete",
  );
  const oldMigrationPath = path.join(root, "old-migrations.mts");
  await writeFile(
    oldMigrationPath,
    execFileSync(
      "git",
      // Pin the real v5 writer blob: HEAD contains v6 after this change is committed.
      ["show", "8270c3d3d6663eea055d6427ed3d4fd4b894e448"],
      { cwd: path.resolve(import.meta.dirname, "../.."), encoding: "utf8" },
    ),
  );
  const { migrateEvolutionDatabase: oldMigrate } = await import(
    oldMigrationPath
  );
  const oldWriter = new Database(evolutionFile);
  assert.throws(() => oldMigrate(oldWriter), /writer|compatible|newer/);
  oldWriter.close();
  const migrated = new EvolutionActivationDatabase(evolutionFile);
  const baseline = migrated.listInsights(id);
  assert.equal(baseline.length, 2);
  assert.ok(baseline.every((i) => i.revisions.length === 2));
  assert.equal(
    baseline.find((i) => i.topicKey === "conflict").lineage.status,
    "contested",
  );
  assert.equal(migrated.getPolicy(id).memoryCanaryEnabled, false);
  assert.equal(migrated.getPolicy(id).canaryRate, 0);
  assert.equal(migrated.getWatermark(id, "activity"), null);
  assert.ok(
    migrated
      .listCandidates()
      .every(
        (c) =>
          c.lifecycle === "retired" ||
          c.lifecycle === "shadow" ||
          c.lifecycle === "needs_revalidation",
      ),
  );
  migrated.close();
  passed(
    "migration-lineage-policy",
    "Original revisions remain; canonical lineage retains agreeing and conflicting views; no Canary authorization or old watermark is inherited",
  );
  await rollbackRepositoryMigration(data, manifest.migrationId);
  for (const kind of ["activity", "evolution"]) {
    const db = openReadOnly(kind === "activity" ? activityFile : evolutionFile);
    assert.equal(fingerprint(db), manifest.fingerprints[kind]);
    db.close();
  }
  passed(
    "rollback",
    "Both databases exactly match the original logical fingerprints",
  );
  await verifyRepositoryStartup(root, data, env, passed);

  const interruptedManifest = await auditRepositoryMigration(data);
  await privateJson(path.join(root, "interrupted.json"), interruptedManifest);
  const moduleUrl = new URL(
    "../../backend/src/evolution/storage/repository-migration-apply.ts",
    import.meta.url,
  ).href;
  const child = path.join(root, "interrupt.mts");
  await writeFile(
    child,
    `import {readFileSync} from 'node:fs';import {applyRepositoryMigration} from ${JSON.stringify(moduleUrl)};await applyRepositoryMigration(JSON.parse(readFileSync(${JSON.stringify(path.join(root, "interrupted.json"))},'utf8')),${JSON.stringify(data)},{afterActivityCommit(){process.exit(73)}});`,
  );
  const interrupted = spawnSync(
    process.execPath,
    [require.resolve("tsx/cli"), child],
    { env, encoding: "utf8" },
  );
  assert.equal(interrupted.status, 73, interrupted.stderr);
  assert.throws(
    () => new EvolutionActivationDatabase(evolutionFile),
    /migration_(required|incomplete)/,
  );
  await applyRepositoryMigration(interruptedManifest, data);
  verifyRepositoryMigration(interruptedManifest, data);
  passed(
    "interruption-resume",
    "Exited between database commits; new writer refused incomplete state, same migration recovered dead owner lock and completed",
  );
  const resumed = await resumeMigratedSchedules(interruptedManifest, data);
  assert.equal(resumed.resumed.length, 1);
  assert.equal(resumed.paused.length, 1);
  const resumedDb = new EvolutionActivationDatabase(evolutionFile);
  const resumedSchedules = resumedDb.listSchedules();
  assert.equal(resumedSchedules.filter((s) => s.enabled).length, 1);
  assert.ok(
    resumedSchedules.filter((s) => !s.enabled).every((s) => s.pausedReason),
  );
  assert.ok(resumedSchedules.every((s) => runIds.includes(s.lastRunId)));
  resumedDb.close();
  passed(
    "schedule-restoration",
    "Only the original enabled schedule with one verified checkout resumes; missing checkout remains paused and history remains intact",
  );
  const writeDb = new EvolutionActivationDatabase(evolutionFile);
  writeDb.createRun({
    ...a,
    runId: randomUUID(),
    createdAt: new Date().toISOString(),
  });
  writeDb.close();
  await assert.rejects(
    rollbackRepositoryMigration(data, interruptedManifest.migrationId),
    /rollback_has_new_writes/,
  );
  passed(
    "rollback-write-protection",
    "A post-migration business Run prevents destructive restore",
  );
  console.log(JSON.stringify({ ok: true, root, results }, null, 2));
} finally {
  await store?.close();
  await activity?.close();
  if (process.env.RUNWEAVE_KEEP_REPOSITORY_FIXTURE !== "1")
    await rm(root, { recursive: true, force: true });
}
