/** Real PostgreSQL/MCP contract check; creates and drops only its own temporary DB. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { userInfo, tmpdir } from "node:os";
import { readdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createRequire } from "node:module";
import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RecordService } from "../src/records/service";
import { FollowupService } from "../src/followups/service";
import { mutate } from "../src/records/mutations";
import { createMcpServer } from "../src/mcp/server";
import { LocalFileStore } from "../src/storage/local-files";
import { AttachmentService } from "../src/storage/attachments";
import type { SuijiInfo, SuijiRecord } from "@runweave/shared/suiji";

const port = Number(process.argv[2] ?? 55439);
assert(Number.isInteger(port) && port > 0 && port < 65536);
const settings = { host: "/tmp", port, user: userInfo().username };
const admin = new pg.Pool({ ...settings, database: "postgres" });
const database = `suiji_changes_verify_${randomUUID().replaceAll("-", "")}`;
const require = createRequire(import.meta.url);
const storageRoot = await mkdtemp(join(tmpdir(), "suiji-changes-attachments-"));
let pool: pg.Pool | undefined;
try {
  assert.equal(
    Math.floor(
      Number(
        (await admin.query("SHOW server_version_num")).rows[0]
          .server_version_num,
      ) / 10000,
    ),
    18,
  );
  await admin.query(`CREATE DATABASE ${database}`);
  pool = new pg.Pool({ ...settings, database });
  const migrations = (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((n) => n.endsWith(".cjs"))
    .sort();
  for (const name of migrations.slice(0, 8)) {
    const sql: string[] = [];
    require(new URL(`../migrations/${name}`, import.meta.url).pathname).up({
      sql: (s: string) => sql.push(s),
    });
    await pool.query(sql.join("\n"));
  }
  const owner = randomUUID();
  await pool.query(
    "INSERT INTO owners(id,username,password_hash) VALUES($1,'verify','unused')",
    [owner],
  );
  const records = new RecordService(pool),
    followups = new FollowupService(pool);
  const context = (actor: "app" | "agent" = "app") => ({
    ownerId: owner,
    actor,
    key: randomUUID(),
    requestId: randomUUID(),
  });
  const seed = (
    await records.create(context(), { kind: "task", body: "baseline" })
  ).record;
  await followups.append(context(), seed.id, { body: "baseline followup" });
  const trashedSeed = (
    await records.create(context(), { kind: "note", body: "trash baseline" })
  ).record;
  await records.trash(context(), trashedSeed.id, {
    trashed: true,
    expectedVersion: 1,
  });
  const sql: string[] = [];
  require(
    new URL(`../migrations/${migrations[8]}`, import.meta.url).pathname,
  ).up({ sql: (s: string) => sql.push(s) });
  await pool.query(`BEGIN; ${sql.join("\n")} COMMIT;`);
  const baseline = await records.changes(owner, { limit: 50 });
  assert.equal(baseline.items.length, 2);
  assert(
    baseline.items.find((item) => item.recordId === trashedSeed.id)!.deleted,
  );
  assert.equal(baseline.items[0]!.kind, "snapshot");
  assert.equal(baseline.items[0]!.recordId, seed.id);
  assert.equal(
    (await followups.list(owner, seed.id, { limit: 20 })).items.length,
    1,
  );
  const empty = await records.changes(owner, {
    cursor: baseline.nextCursor,
    limit: 20,
  });
  assert.equal(empty.items.length, 0);
  const retryContext = context("agent");
  const appended = await followups.append(retryContext, seed.id, {
    body: "agent final result",
  });
  await followups.append(retryContext, seed.id, { body: "agent final result" });
  assert.equal((await records.get(owner, seed.id)).version, seed.version);
  await assert.rejects(
    records.create(retryContext, { kind: "note", body: "wrong operation" }),
    (error) => (error as { code?: string }).code === "IDEMPOTENCY_KEY_REUSED",
  );
  await records.edit(context(), seed.id, {
    body: "edited",
    expectedVersion: 1,
  });
  await records.edit(context(), seed.id, {
    body: "edited",
    expectedVersion: 2,
  }); // no-op
  await records.status(context(), seed.id, {
    targetStatus: "done",
    expectedVersion: 2,
  });
  await records.trash(context(), seed.id, {
    trashed: true,
    expectedVersion: 3,
  });
  let page = await records.changes(owner, {
    cursor: empty.nextCursor,
    limit: 1,
  });
  assert(page.hasMore);
  assert.equal(page.items[0]!.kind, "followup_added");
  assert.equal(page.items[0]!.followupId, appended.followup.id);
  assert.equal(page.items[0]!.actor, "agent");
  assert(page.items[0]!.currentlyDeleted);
  await assert.rejects(records.get(owner, seed.id));
  await assert.rejects(followups.list(owner, seed.id, { limit: 20 }));
  await records.trash(context(), seed.id, {
    trashed: false,
    expectedVersion: 4,
  });
  const seen = [...page.items];
  while (page.hasMore) {
    page = await records.changes(owner, { cursor: page.nextCursor, limit: 1 });
    seen.push(...page.items);
  }
  assert.equal(seen.length, 4); // fixed upper bound excludes restore
  assert.deepEqual(
    seen.map((e) => e.sequence),
    ["3", "4", "5", "6"],
  );
  assert.equal(seen.at(-1)!.deleted, true);
  const restored = await records.changes(owner, {
    cursor: page.nextCursor,
    limit: 20,
  });
  assert.equal(restored.items.length, 1);
  assert.equal(restored.items[0]!.deleted, false);
  assert.equal(restored.items[0]!.recordVersion, 5);
  await assert.rejects(
    records.changes(randomUUID(), { cursor: restored.nextCursor, limit: 20 }),
  );
  await assert.rejects(records.changes(owner, { cursor: "bad", limit: 20 }));
  const invalid = JSON.parse(
    Buffer.from(restored.nextCursor, "base64url").toString(),
  );
  for (const overrides of [{ epoch: randomUUID() }, { after: "999999" }]) {
    await assert.rejects(
      records.changes(owner, {
        cursor: Buffer.from(
          JSON.stringify({ ...invalid, ...overrides }),
        ).toString("base64url"),
        limit: 20,
      }),
    );
  }
  // An uncommitted change must not let another commit receive a higher visible number.
  const held = await pool.connect();
  const waiter = await pool.connect();
  try {
    await held.query("BEGIN");
    await held.query("UPDATE records SET version=version+1 WHERE id=$1", [
      seed.id,
    ]);
    await held.query(
      "INSERT INTO record_revisions(owner_id,record_id,version,snapshot,request_id,actor) VALUES($1,$2,6,'{}',$3,'app')",
      [owner, seed.id, randomUUID()],
    );
    const during = await records.changes(owner, {
      cursor: restored.nextCursor,
      limit: 20,
    });
    assert.equal(during.items.length, 0);
    const waiterPid = (await waiter.query("SELECT pg_backend_pid() AS pid"))
      .rows[0].pid;
    await waiter.query("BEGIN");
    const waiting = waiter.query(
      "UPDATE record_change_heads SET sequence=sequence+1 WHERE owner_id=$1",
      [owner],
    );
    let blocked = false;
    for (let i = 0; i < 100 && !blocked; i++) {
      const lock = await pool.query(
        "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",
        [waiterPid],
      );
      blocked = lock.rows[0]?.wait_event_type === "Lock";
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(blocked, "owner counter must block until earlier transaction ends");
    await held.query("ROLLBACK");
    await waiting;
    await waiter.query("ROLLBACK");
  } finally {
    held.release();
    waiter.release();
  }
  await assert.rejects(
    mutate(pool, context(), "verify-rollback", {}, async (client) => {
      await client.query(
        "INSERT INTO record_followups(id,owner_id,record_id,sequence,body,actor) VALUES($1,$2,$3,3,'rolled back','app')",
        [randomUUID(), owner, seed.id],
      );
      throw new Error("rollback");
    }),
  );
  assert.equal(
    (await records.changes(owner, { cursor: restored.nextCursor, limit: 20 }))
      .items.length,
    0,
  );
  const created = (
    await records.create(context(), { kind: "note", body: "new record" })
  ).record;
  const next = await records.changes(owner, {
    cursor: restored.nextCursor,
    limit: 20,
  });
  assert.equal(next.items[0]!.sequence, "8");
  assert.equal(next.items[0]!.recordId, created.id);
  // Exercise actual MCP registration, annotations, schema and serialization.
  const store = new LocalFileStore(storageRoot);
  await store.initialize();
  const attachments = new AttachmentService(pool, store);
  const file = await store.stage(
    Readable.from([Buffer.from("attachment fixture")]),
  );
  const uploaded = await attachments.upload(
    context("agent"),
    file,
    "fixture.md",
    "text/markdown",
  );
  const server = createMcpServer(
    records,
    attachments,
    owner,
    randomUUID(),
    "verify",
    followups,
    async () => ({}) as SuijiInfo,
  );
  const client = new Client({ name: "verify", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tool = (await client.listTools()).tools.find(
      (t) => t.name === "list_changes",
    )!;
    assert.equal(tool.annotations?.readOnlyHint, true);
    const reply = await client.callTool({
      name: "list_changes",
      arguments: { cursor: restored.nextCursor, limit: 1 },
    });
    assert(!reply.isError);
    assert.equal(JSON.stringify(reply).includes("new record"), false);
    const bad = await client.callTool({
      name: "list_changes",
      arguments: { limit: 0 },
    });
    assert(bad.isError);
    for (const args of [{ limit: 51 }, { kind: "task" }])
      assert(
        (await client.callTool({ name: "list_changes", arguments: args }))
          .isError,
      );
    const names = (await client.listTools()).tools
      .map((tool) => tool.name)
      .sort();
    assert.deepEqual(
      names,
      [
        "list_changes",
        "list_records",
        "search_records",
        "get_record",
        "create_record",
        "replace_record_body",
        "set_task_status",
        "read_attachment",
        "get_service_info",
        "list_followups",
        "append_followup",
      ].sort(),
    );
    for (const [name, args] of [
      ["list_records", {}],
      ["search_records", { query: "edited" }],
      ["get_record", { recordId: seed.id }],
      ["list_followups", { recordId: seed.id }],
      ["get_service_info", {}],
      ["read_attachment", { attachmentId: uploaded.attachment.id }],
    ] as const)
      assert(!(await client.callTool({ name, arguments: args })).isError, name);
    const key = randomUUID();
    const input = {
      kind: "task",
      body: "MCP application fixture",
      idempotencyKey: key,
    };
    const createdReply = await client.callTool({
      name: "create_record",
      arguments: input,
    });
    assert(!createdReply.isError);
    const task = (createdReply.structuredContent as { record: SuijiRecord })
      .record;
    const replay = await client.callTool({
      name: "create_record",
      arguments: input,
    });
    assert.equal(
      (replay.structuredContent as { record: SuijiRecord }).record.id,
      task.id,
    );
    const mixed = await client.callTool({
      name: "replace_record_body",
      arguments: {
        recordId: task.id,
        body: "different tool",
        expectedVersion: 1,
        idempotencyKey: key,
      },
    });
    assert.equal(
      (mixed.structuredContent as { error: { code: string } }).error.code,
      "IDEMPOTENCY_KEY_REUSED",
    );
    for (const [name, args] of [
      [
        "replace_record_body",
        { recordId: task.id, body: "MCP edited fixture", expectedVersion: 1 },
      ],
      [
        "set_task_status",
        { recordId: task.id, targetStatus: "done", expectedVersion: 2 },
      ],
      ["append_followup", { recordId: task.id, body: "MCP final fixture" }],
    ] as const)
      assert(
        !(
          await client.callTool({
            name,
            arguments: { ...args, idempotencyKey: randomUUID() },
          })
        ).isError,
        name,
      );
    const saved = await records.get(owner, task.id);
    assert.equal(saved.body, "MCP edited fixture");
    assert.equal(saved.taskStatus, "done");
    assert.equal(saved.version, 3);
    assert.equal(
      (await followups.list(owner, task.id, { limit: 20 })).items.length,
      1,
    );
  } finally {
    await client.close();
    await server.close();
  }
  console.log(
    JSON.stringify({
      ok: true,
      checks: [
        "schema9 baseline",
        "create/edit/status/trash/restore",
        "followup without parent version change",
        "idempotent replay and no-op",
        "bounded pagination",
        "empty checkpoint",
        "owner/epoch/future cursor rejection",
        "uncommitted counter lock",
        "rollback atomicity",
        "MCP contract and metadata privacy",
        "existing ten MCP tools retain application read/write",
        "attachment upload/read compatibility",
      ],
    }),
  );
} finally {
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${database}`);
  await admin.end();
  await rm(storageRoot, { recursive: true, force: true });
}
