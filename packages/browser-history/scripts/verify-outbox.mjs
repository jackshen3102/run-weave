// Integration: actual durable queue files, failing filesystem target, reopen and collect readback.
import { mkdtemp, writeFile, rm, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { BrowserHistoryOutbox } = require("../dist/outbox.cjs");
const base = fileURLToPath(new URL("../dist/", import.meta.url));
const temporary = await mkdtemp(
  path.join(os.tmpdir(), "runweave-outbox-verify-"),
);
const root = path.join(temporary, "logs"),
  pending = path.join(temporary, "pending");
const source = {
  sourceId: randomUUID(),
  browser: "runweave",
  profileLabel: "profile-1",
};
const row = {
  schemaVersion: 1,
  ...source,
  visitId: randomUUID(),
  revision: 1,
  visitedAt: "2026-10-26T16:00:00.000Z",
  observedAt: "2026-10-26T16:00:00.000Z",
  url: "https://example.com/queue",
  title: "队列集成样例",
  navigation: "document",
  actor: "unknown",
};
const hash = (data) => createHash("sha256").update(data).digest("hex");
let queue;
try {
  await writeFile(root, "not a directory");
  queue = new BrowserHistoryOutbox(root, pending, source);
  queue.enqueue(row);
  await queue.flush();
  assert.equal(queue.pending, 1);
  assert.ok(queue.error);
  const original = await readFile(path.join(pending, `${row.visitId}.1.json`));
  assert.equal(
    (await stat(path.join(pending, `${row.visitId}.1.json`))).mode & 0o777,
    0o600,
  );
  await queue.close();
  queue = new BrowserHistoryOutbox(root, pending, source);
  assert.equal(queue.pending, 1);
  assert.deepEqual(JSON.parse(original), row);
  await rm(root);
  await queue.flush();
  assert.equal(queue.pending, 0);
  assert.equal(queue.error, null);
  assert.ok(queue.lastStoredAt);
  const savedAt = queue.lastStoredAt;
  await queue.close();
  // Simulate a process dying after the log write but before removing the pending observation.
  await writeFile(path.join(pending, `${row.visitId}.1.json`), original, {
    mode: 0o600,
  });
  queue = new BrowserHistoryOutbox(root, pending, source);
  assert.equal(queue.lastStoredAt, savedAt);
  await queue.flush();
  await queue.close();
  const out = path.join(temporary, "readback");
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        path.join(base, "cli.cjs"),
        "collect",
        "--root",
        root,
        "--from",
        "2026-10-27",
        "--to",
        "2026-10-27",
        "--out",
        out,
      ],
      { encoding: "utf8" },
    ),
  );
  assert.equal(result.visits, 1);
  assert.equal(result.readStatus, "complete");
  const material = JSON.parse(
    (await readFile(path.join(out, "visits.jsonl"), "utf8")).trim(),
  );
  assert.equal(material.visit.visitId, row.visitId);
  assert.equal(material.visit.visitedAt, row.visitedAt);
  const blocked = path.join(temporary, "blocked");
  await writeFile(blocked, "offline");
  const capacity = path.join(temporary, "capacity");
  queue = new BrowserHistoryOutbox(blocked, capacity, source);
  let first,
    count = 0;
  for (;;) {
    const item = {
      ...row,
      visitId: randomUUID(),
      url: "https://example.com/" + "x".repeat(3900),
      title: "界".repeat(512),
    };
    try {
      queue.enqueue(item);
      count++;
      if (!first) first = item;
    } catch (e) {
      assert.match(String(e), /4 MiB/);
      break;
    }
  }
  await queue.flush();
  const firstFile = path.join(capacity, `${first.visitId}.1.json`),
    before = hash(await readFile(firstFile));
  assert.ok(count > 100);
  assert.equal(queue.pending, count);
  assert.equal(hash(await readFile(firstFile)), before);
  await rm(blocked);
  await queue.flush();
  assert.equal(queue.pending, 0);
  await queue.close();
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "durable before delivery",
        "failed target retains pending",
        "reopen retains identity",
        "ACK replay deduplicated",
        "last stored receipt survives reopen",
        "4 MiB preserves oldest observations",
        "recovered queue drains",
        "private queue files",
      ],
    }),
  );
} finally {
  await queue?.close();
  await rm(temporary, { recursive: true, force: true });
}
