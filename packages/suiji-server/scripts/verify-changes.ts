/** Real PostgreSQL/MCP contract check; creates and drops only its own temporary DB. */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import pg from "pg";
import express from "express";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpRouter } from "../src/mcp/router";
import { registerCredential, listCredentials } from "../src/mcp/credentials";
import type { Config } from "../src/config";
import type { LocalFileStore } from "../src/storage/local-files";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RecordService } from "../src/records/service";
import { FollowupService } from "../src/followups/service";
import { mutate } from "../src/records/mutations";
import { createMcpServer } from "../src/mcp/server";
import type { AttachmentService } from "../src/storage/attachments";
import type { SuijiInfo } from "@runweave/shared/suiji";

const port = Number(process.argv[2] ?? 55439);
assert(Number.isInteger(port) && port > 0 && port < 65536);
const settings = { host: "/tmp", port, user: userInfo().username };
const admin = new pg.Pool({ ...settings, database: "postgres" });
const database = `suiji_changes_verify_${randomUUID().replaceAll("-", "")}`;
const require = createRequire(import.meta.url);
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
  const trashedSeed = (await records.create(context(), { kind: "note", body: "trash baseline" })).record;
  await records.trash(context(), trashedSeed.id, { trashed: true, expectedVersion: 1 });
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
  const server = createMcpServer(
    records,
    {} as AttachmentService,
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
  } finally {
    await client.close();
    await server.close();
  }
  // Real HTTP scope enforcement with synthetic credentials in the temporary DB.
  const legacyToken = randomBytes(32).toString("base64url");
  const legacyId = randomUUID();
  const hash = (token: string) =>
    createHash("sha256").update(token).digest("hex");
  await pool.query(
    "INSERT INTO mcp_credentials(id,owner_id,name,token_sha256,expires_at,source) VALUES($1,$2,'old',$3,clock_timestamp()+interval '1 day','generated')",
    [legacyId, owner, hash(legacyToken)],
  );
  const scopeSql: string[] = [];
  require(
    new URL(`../migrations/${migrations[9]}`, import.meta.url).pathname,
  ).up({ sql: (s: string) => scopeSql.push(s) });
  await pool.query(scopeSql.join("\n"));
  assert.equal(
    (await listCredentials(pool)).find((row) => row.id === legacyId)!.scope,
    "read-write",
  );
  const readToken = randomBytes(32).toString("base64url");
  const registration = {
    version: 1,
    id: randomUUID(),
    serverId: (await pool.query("SELECT server_id FROM server_identity"))
      .rows[0].server_id,
    ownerId: owner,
    name: "read fixture",
    tokenSha256: hash(readToken),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    scope: "read-only",
  };
  assert.equal((await registerCredential(pool, registration)).created, true);
  assert.equal((await registerCredential(pool, registration)).created, false);
  await assert.rejects(
    registerCredential(pool, { ...registration, scope: "read-write" }),
  );
  await assert.rejects(
    registerCredential(pool, { ...registration, scope: "unknown" }),
  );
  await pool.query("CREATE TABLE suiji_migrations(version integer)");
  await pool.query("INSERT INTO suiji_migrations SELECT generate_series(1,10)");
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.requestId = randomUUID();
    next();
  });
  app.use(
    "/mcp",
    createMcpRouter(
      pool,
      records,
      {} as AttachmentService,
      { SUIJI_MCP_ENABLED: true, SUIJI_APP_VERSION: "verify" } as Config,
      followups,
      {} as LocalFileStore,
    ),
  );
  app.use(
    (
      error: { status?: number; code?: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      void _next;
      res
        .status(error.status ?? 500)
        .json({ error: error.code ?? "unexpected" });
    },
  );
  const http = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => http.once("listening", resolve));
  const address = http.address();
  assert(address && typeof address !== "string");
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const readClient = new Client({ name: "read-scope-verify", version: "1" });
  const fullClient = new Client({ name: "old-scope-verify", version: "1" });
  try {
    await readClient.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${readToken}` } },
      }),
    );
    const info = await readClient.callTool({
      name: "get_service_info",
      arguments: {},
    });
    assert.equal(
      (info.structuredContent as { features: { changes: boolean } }).features
        .changes,
      true,
    );
    assert(
      !(await readClient.callTool({ name: "list_changes", arguments: {} }))
        .isError,
    );
    const before = (await records.changes(owner, { limit: 50 })).items.length;
    for (const [name, args] of [
      ["create_record", { kind: "note", body: "denied" }],
      [
        "replace_record_body",
        { recordId: seed.id, body: "denied", expectedVersion: 5 },
      ],
      [
        "set_task_status",
        { recordId: seed.id, targetStatus: "open", expectedVersion: 5 },
      ],
      ["append_followup", { recordId: seed.id, body: "denied" }],
    ] as const) {
      const denied = await readClient.callTool({
        name,
        arguments: { ...args, idempotencyKey: randomUUID() },
      });
      assert(denied.isError, name);
      assert.equal(
        (denied.structuredContent as { error: { code: string } }).error.code,
        "FORBIDDEN",
      );
    }
    const upload = await fetch(`${url}/uploads`, {
      method: "POST",
      headers: { Authorization: `Bearer ${readToken}` },
      body: "crafted upload",
    });
    assert.equal(upload.status, 403);
    assert.equal(
      ((await upload.json()) as { error: string }).error,
      "FORBIDDEN",
    );
    assert.equal(
      (await records.changes(owner, { limit: 50 })).items.length,
      before,
    );
    await fullClient.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${legacyToken}` } },
      }),
    );
    assert(
      !(
        await fullClient.callTool({
          name: "create_record",
          arguments: {
            kind: "note",
            body: "legacy still writes",
            idempotencyKey: randomUUID(),
          },
        })
      ).isError,
    );
  } finally {
    await readClient.close();
    await fullClient.close();
    await new Promise<void>((resolve, reject) =>
      http.close((error) => (error ? reject(error) : resolve())),
    );
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
        "schema10 legacy compatibility",
        "read-only HTTP denies all write tools and uploads",
        "registration cannot escalate scope",
      ],
    }),
  );
} finally {
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${database}`);
  await admin.end();
}
