import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ActivityEventInput,
  ActivityRuntimeChannel,
} from "@runweave/shared/activity";
import { ActivityEventFactory } from "../backend/src/activity/event-factory";
import { listActivitySchemas } from "../backend/src/activity/registry";
import { ActivityStore } from "../backend/src/activity/activity-store";

const currentFile = fileURLToPath(import.meta.url);
const requireFromBackend = createRequire(
  new URL("../backend/package.json", import.meta.url),
);

function testEnv(activityHome: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    RUNWEAVE_ACTIVITY_TEST_MODE: "true",
    RUNWEAVE_ACTIVITY_HOME: activityHome,
  };
}

function factory(
  instanceId: string,
  runtimeChannel: ActivityRuntimeChannel = "dev",
): ActivityEventFactory {
  return new ActivityEventFactory({
    producerName: "activity-verifier",
    producerVersion: "1",
    producerInstanceId: instanceId,
    runtimeChannel,
    runtimeSurface: "backend",
  });
}

async function runWriter(
  databasePath: string,
  activityHome: string,
  instanceId: string,
  runtimeChannel: ActivityRuntimeChannel,
  count: number,
): Promise<void> {
  const store = await ActivityStore.create({
    databasePath,
    env: testEnv(activityHome),
  });
  try {
    const producer = factory(instanceId, runtimeChannel);
    const events = Array.from({ length: count }, (_, index) =>
      producer.create({
        eventName: "terminal.session.created",
        scope: { projectId: "concurrency-fixture" },
        payload: { index },
      }),
    );
    const acknowledgements = await store.record(events);
    assert.equal(
      acknowledgements.filter((ack) => ack.status === "committed").length,
      count,
    );
  } finally {
    await store.close();
  }
}

function spawnWriter(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const repoRoot = path.resolve(path.dirname(currentFile), "..");
    const child = spawn("pnpm", [
      "--filter",
      "@runweave/backend",
      "exec",
      "tsx",
      "../scripts/verify-activity-data-foundation.ts",
      "writer",
      ...args,
    ], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(
        new Error(
          `activity writer exited ${code}: ${stderr.trim()} ${stdout.trim()}`.trim(),
        ),
      );
    });
  });
}

async function readAllFacts(store: ActivityStore, projectId: string) {
  const facts = [];
  let cursor: string | undefined;
  let asOfActivityOffset: number | undefined;
  do {
    const page = await store.facts({
      projectId,
      cursor,
      asOfActivityOffset,
      limit: 200,
    });
    facts.push(...page.facts);
    cursor = page.nextCursor;
    asOfActivityOffset ??= page.asOfActivityOffset;
  } while (cursor);
  return facts;
}

function contentEvent(
  producer: ActivityEventFactory,
  params: { projectId: string; text: string; occurredAt?: string },
): ActivityEventInput {
  const event = producer.create({
    eventName: "agent.response.observed",
    occurredAt: params.occurredAt,
    actorType: "agent",
    actorAgent: "codex",
    scope: { projectId: params.projectId, interactionId: crypto.randomUUID() },
    payload: { token: "must-not-be-stored" },
  });
  event.contents.push({
    contentId: crypto.randomUUID(),
    role: "response",
    mediaType: "text/plain; charset=utf-8",
    bytesBase64: Buffer.from(params.text).toString("base64"),
  });
  return event;
}

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "runweave-activity-verify-"));
  const activityHome = path.join(root, "activity");
  const databasePath = path.join(activityHome, "activity.sqlite");
  const startedAt = new Date().toISOString();
  try {
    await Promise.all([
      spawnWriter([databasePath, activityHome, "stable-writer", "stable", "100"]),
      spawnWriter([databasePath, activityHome, "beta-writer", "beta", "100"]),
      spawnWriter([databasePath, activityHome, "dev-writer", "dev", "100"]),
    ]);

    const stores = await Promise.all(
      Array.from({ length: 3 }, () =>
        ActivityStore.create({ databasePath, env: testEnv(activityHome) }),
      ),
    );
    const [store] = stores;
    assert(store);
    const BetterSqlite = requireFromBackend("better-sqlite3") as typeof import("better-sqlite3");
    try {
      for (const candidate of stores) {
        assert.equal((await readAllFacts(candidate, "concurrency-fixture")).length, 300);
        assert.equal(await candidate.integrity(), true);
      }

      const idempotentFactory = factory("idempotency-fixture");
      const original = idempotentFactory.create({
        eventName: "terminal.session.created",
        scope: { projectId: "idempotency-fixture" },
        payload: { state: "original" },
      });
      assert.equal((await store.record([original]))[0]?.status, "committed");
      assert.equal((await store.record([original]))[0]?.status, "duplicate");
      await assert.rejects(
        store.record([{ ...original, payload: { state: "conflict" } }]),
        /activity_idempotency_conflict/,
      );

      const gapBase = factory("gap-fixture");
      const first = gapBase.create({ eventName: "terminal.session.created" });
      const second = gapBase.create({ eventName: "terminal.session.deleted" });
      const third = gapBase.create({ eventName: "terminal.session.created" });
      await store.record([first, third]);
      assert.equal(
        (await store.sources()).find((source) => source.producerInstanceId === "gap-fixture")?.openGapCount,
        1,
      );
      await store.record([second]);
      const closedGapSource = (await store.sources()).find(
        (source) => source.producerInstanceId === "gap-fixture",
      );
      assert.equal(closedGapSource?.openGapCount, 0);
      assert.equal(closedGapSource?.highestContiguousSequence, 3);

      const contentProducer = factory("content-fixture");
      const content = contentEvent(contentProducer, {
        projectId: "content-fixture",
        text: "answer password=top-secret",
      });
      await store.record([content]);
      const contentSnapshot = await store.preview({ projectId: "content-fixture" });
      assert.equal(
        (await store.exportSnapshot({
          scope: { projectId: "content-fixture" },
          asOfActivityOffset: contentSnapshot.asOfActivityOffset,
        })).length,
        1,
      );
      const readContent = await store.content(content.contents[0]!.contentId);
      assert.equal(readContent?.availability, "available");
      assert.match(
        Buffer.from(readContent?.bytesBase64 ?? "", "base64").toString("utf8"),
        /\[REDACTED\]/,
      );
      assert.equal(
        await store.auditSubjectHmac("runweave-user"),
        await stores[1]!.auditSubjectHmac("runweave-user"),
      );

      const retentionProducer = factory("retention-fixture");
      const now = Date.now();
      const expiredContent = contentEvent(retentionProducer, {
        projectId: "retention-content",
        text: "expires after seven days",
        occurredAt: new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString(),
      });
      const expiredFact = retentionProducer.create({
        eventName: "terminal.session.created",
        occurredAt: new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString(),
        scope: { projectId: "retention-fact" },
      });
      await store.record([expiredContent, expiredFact], now);
      await store.runRetention("retention-owner", now);
      assert.equal(
        (await store.content(expiredContent.contents[0]!.contentId))?.availability,
        "expired",
      );
      assert.equal((await readAllFacts(store, "retention-content")).length, 1);
      assert.equal((await readAllFacts(store, "retention-fact")).length, 0);

      const deleteProducer = factory("delete-fixture");
      await store.record(
        Array.from({ length: 5 }, (_, index) =>
          deleteProducer.create({
            eventName: "terminal.session.created",
            scope: { projectId: "delete-fixture" },
            payload: { index },
          }),
        ),
      );
      const snapshot = await store.preview({ projectId: "delete-fixture" });
      await store.record([
        deleteProducer.create({
          eventName: "terminal.session.created",
          scope: { projectId: "delete-fixture" },
          payload: { index: "after-cutoff" },
        }),
      ]);
      const job = await store.createDeleteJob({
        requestId: crypto.randomUUID(),
        backendInstanceId: "verification-backend",
        authSubjectHmac: await store.auditSubjectHmac("runweave-user"),
        scope: { projectId: "delete-fixture" },
        snapshot,
        nowMs: now,
      });
      await assert.rejects(
        store.createDeleteJob({
          requestId: crypto.randomUUID(),
          backendInstanceId: "verification-backend-2",
          authSubjectHmac: await store.auditSubjectHmac("runweave-user"),
          scope: { projectId: "delete-fixture" },
          snapshot,
          nowMs: now,
        }),
        /activity_delete_in_progress/,
      );
      let currentJob = job;
      while (currentJob.status !== "completed") {
        currentJob = (await store.runDelete("delete-owner", now + 1)) ?? currentJob;
      }
      const remaining = await readAllFacts(store, "delete-fixture");
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0]?.payload.index, "after-cutoff");

      const blockedFactory = factory("blocked-delete-fixture");
      await store.record([
        blockedFactory.create({
          eventName: "terminal.session.created",
          scope: { projectId: "blocked-delete-fixture" },
        }),
      ], now);
      const blockedSnapshot = await store.preview({
        projectId: "blocked-delete-fixture",
      });
      const blockedJob = await store.createDeleteJob({
        requestId: crypto.randomUUID(),
        backendInstanceId: "verification-backend-3",
        authSubjectHmac: await store.auditSubjectHmac("runweave-user"),
        scope: { projectId: "blocked-delete-fixture" },
        snapshot: blockedSnapshot,
        nowMs: now,
      });
      const faultDatabase = new BetterSqlite(databasePath);
      faultDatabase.exec(
        `CREATE TRIGGER activity_verify_delete_fault
         BEFORE DELETE ON behavior_facts
         WHEN OLD.project_id = 'blocked-delete-fixture'
         BEGIN SELECT RAISE(ABORT, 'fixture_delete_blocked'); END`,
      );
      faultDatabase.close();
      await assert.rejects(
        store.runDelete("blocked-delete-owner", now + 10_001),
        /fixture_delete_blocked/,
      );
      assert.equal((await store.deleteStatus(blockedJob.deleteJobId))?.status, "blocked");
      const recoveryDatabase = new BetterSqlite(databasePath);
      recoveryDatabase.exec("DROP TRIGGER activity_verify_delete_fault");
      recoveryDatabase.close();
      let recoveredJob = await store.runDelete("blocked-delete-owner", now + 10_002);
      while (recoveredJob && recoveredJob.status !== "completed") {
        recoveredJob = await store.runDelete("blocked-delete-owner", now + 10_003);
      }
      assert.equal(recoveredJob?.status, "completed");

      assert.equal(
        listActivitySchemas().some((schema) => schema.eventName.startsWith("verification.")),
        false,
      );

      await store.runRetention("lease-owner-a", now + 1);
      await stores[1]!.runRetention("lease-owner-b", now + 2);
      await stores[1]!.runRetention("lease-owner-b", now + 10_001);
      await store.runRetention("lease-owner-a", now + 20_002);
      const leaseReader = new BetterSqlite(databasePath, { readonly: true });
      const lease = leaseReader.prepare(
        `SELECT owner_backend_instance_id AS owner, fencing_token AS token
         FROM maintenance_leases WHERE lease_name = 'retention'`,
      ).get() as { owner: string; token: number };
      leaseReader.close();
      assert.deepEqual(lease, { owner: "lease-owner-a", token: 3 });
    } finally {
      await Promise.all(stores.map((store) => store.close()));
    }

    const directoryMode = (await stat(activityHome)).mode & 0o777;
    const databaseMode = (await stat(databasePath)).mode & 0o777;
    assert.equal(directoryMode, 0o700);
    assert.equal(databaseMode, 0o600);

    const quotaHome = path.join(root, "quota-activity");
    const quotaStore = await ActivityStore.create({
      databasePath: path.join(quotaHome, "activity.sqlite"),
      env: {
        ...testEnv(quotaHome),
        RUNWEAVE_ACTIVITY_TEST_MAX_DATABASE_BYTES: "1",
      },
    });
    try {
      const quotaEvent = contentEvent(factory("quota-fixture"), {
        projectId: "quota-fixture",
        text: "metadata must survive without persisted content",
        occurredAt: new Date().toISOString(),
      });
      assert.equal((await quotaStore.record([quotaEvent]))[0]?.status, "committed");
      const quotaFacts = await readAllFacts(quotaStore, "quota-fixture");
      assert.equal(quotaFacts.length, 1);
      assert.equal(quotaFacts[0]?.contentDescriptors.length, 0);
    } finally {
      await quotaStore.close();
    }

    const futureDatabasePath = path.join(root, "future.sqlite");
    const futureDatabase = new BetterSqlite(futureDatabasePath);
    futureDatabase.pragma("user_version = 2000");
    futureDatabase.close();
    await assert.rejects(
      ActivityStore.create({ databasePath: futureDatabasePath, env: testEnv(activityHome) }),
      /activity_schema_too_new/,
    );

    process.stdout.write(`${JSON.stringify({
      ok: true,
      startedAt,
      completedAt: new Date().toISOString(),
      databasePath,
      multiProcessFacts: 300,
      checks: [
        "three-process-wal",
        "exclusive-first-key-initialization",
        "idempotency-and-conflict",
        "sequence-gap-close",
        "content-redaction-and-decryption",
        "consistent-export-snapshot",
        "activity-key-audit-hmac",
        "retention-7d-30d",
        "delete-cutoff",
        "single-active-delete-job",
        "delete-blocked-recovery",
        "maintenance-fencing-token",
        "quota-metadata-fallback",
        "verification-family-disabled",
        "schema-too-new-fail-closed",
        "filesystem-permissions",
      ],
    }, null, 2)}\n`);
  } finally {
    if (process.env.RUNWEAVE_KEEP_ACTIVITY_VERIFY !== "true") {
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function run(): Promise<void> {
  if (process.argv[2] === "writer") {
    const [, , , databasePath, activityHome, instanceId, channel, rawCount] = process.argv;
    await runWriter(
      databasePath!,
      activityHome!,
      instanceId!,
      channel as ActivityRuntimeChannel,
      Number(rawCount),
    );
    return;
  }
  await main();
}

void run().catch((error) => {
  const detail = error instanceof Error
    ? error.stack
    : JSON.stringify(error, Object.getOwnPropertyNames(error as object), 2);
  process.stderr.write(`${detail || String(error)}\n`);
  process.exitCode = 1;
});
