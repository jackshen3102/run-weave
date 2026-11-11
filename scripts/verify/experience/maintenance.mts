import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rename, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { ExperienceService } from "../../../backend/src/experience/service";
import { ExperienceLearningRuntime } from "../../../backend/src/experience/learning-runtime";
import { createExperienceRouter } from "../../../backend/src/routes/experience";

import type { ExperienceCandidate, ExperienceDraft } from "@runweave/shared/experience";
import type { AuthContext } from "../../../packages/runweave-cli/src/client/auth-context";

// Real HTTP, Git identities, SQLite and CLI request construction. Only isolated fixture data.
const require = createRequire(new URL("../../../backend/package.json", import.meta.url));
const { runExperienceMaintenance } = require(new URL("../../../packages/runweave-cli/src/commands/experience-maintenance.ts", import.meta.url).pathname) as typeof import("../../../packages/runweave-cli/src/commands/experience-maintenance");
const express = require("express") as typeof import("express");
const root = await mkdtemp(path.join(os.tmpdir(), "experience-maintenance-"));
const storage = { home: path.join(root, "data"), namespace: "maintenance" };
const service = new ExperienceService(storage);
const learning = new ExperienceLearningRuntime(storage, service, null, false, "dev", error => { throw error; });
const cwd = path.join(root, "repo");
await mkdir(cwd);
execFileSync("git", ["init", "--quiet", cwd]);
const scope = await service.scope(cwd);
const other = "b".repeat(64);
let available = true;
const app = express();
app.use(express.json());
app.use("/api/experience", createExperienceRouter(service, learning, {
  list: async () => [
    { repositoryId: scope.repositoryId, commonDirectory: path.join(cwd, ".git"), paths: [cwd], projectIds: [], name: "fixture", available },
    { repositoryId: other, commonDirectory: "/missing", paths: ["/missing"], projectIds: [], name: "empty", available: false },
  ],
}));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const request = (route: string, body?: unknown, headers?: Record<string, string>) => fetch(base + "/api/experience/" + route, {
  method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
try {
  const evidence = path.join(root, "evidence.txt");
  await writeFile(evidence, "controlled maintenance evidence\n");
  const draft: ExperienceDraft = { id: "maintenance-fixture", title: "Controlled evidence", triggers: [["maintenance"]],
    applicability: "fixture only", avoid: ["production"], actions: ["inspect"], verification: ["read back"],
    expiresAt: new Date(Date.now() + 86400000).toISOString(), state: "active",
    evidence: [{ path: evidence, startLine: 1, endLine: 1, note: "fixture" }] };
  let record = (await service.save(cwd, draft)).record;
  for (let i = 0; i < 2; i++) record = (await service.save(cwd, { ...draft, title: `revision-${i}` }, record.revision)).record;
  const id = createHash("sha256").update("candidate").digest("hex");
  const candidate: ExperienceCandidate = { candidateId: id, sourceJobId: "fixture", evidenceIds: ["evidence"],
    record: { ...record, id: "unpublished-fixture", revision: randomUUID() }, expectedRevision: null, status: "pending", review: null };
  await service.stage(cwd, candidate);
  const route = `candidates/${id}`;
  const first = await (await request(`${route}?${new URLSearchParams({ cwd })}`)).json();
  await service.reviewCandidate(cwd, id, { verdict: "insufficient", reason: "latest review" });
  assert.equal((await request(`${route}/retire`, { cwd, expectedVersion: first.version, reason: "stale" })).status, 409);
  const current = await (await request(`${route}?${new URLSearchParams({ cwd })}`)).json();
  await rm(evidence); // Retirement must preserve archived evidence without requiring lost source files.
  const body = { cwd, expectedVersion: current.version, reason: "已核对：仅是隔离验收过程" };
  const retired = await (await request(`${route}/retire`, body)).json();
  assert.equal(retired.candidate.status, "retired");
  assert.deepEqual(retired.candidate.record, current.candidate.record);
  assert.deepEqual(retired.candidate.review, current.candidate.review);
  assert.equal(retired.candidate.retirement.reason, body.reason);
  assert.deepEqual(await (await request(`${route}/retire`, body)).json(), retired);
  assert.equal((await request(`${route}/retire`, { ...body, reason: "different" })).status, 409);
  assert.equal((await service.reviewCandidate(cwd, id, { verdict: "supported", reason: "late reviewer" })).status, "retired");
  assert.deepEqual((await service.show(cwd, record.id)).record, record);
  console.log("PASS HTTP retirement CAS, exact replay, review/evidence preservation, lost source and late promotion rejection");

  for (let i = 0; i < 125; i++) learning.queue.enqueue({ jobId: createHash("sha256").update(`job-${i}`).digest("hex"),
    repositoryId: i < 120 ? scope.repositoryId : other, cwd, threadId: `thread-${i}`, createdAt: new Date().toISOString(),
    source: { terminalSessionId: "fixture", threadId: `thread-${i}`, panelId: null, completedAt: new Date().toISOString(), channel: "dev" } });
  const auth = { requestJson: async (route: string, init?: RequestInit) => {
    const response = await fetch(base + route, init);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  } } as AuthContext;
  const jobs = await runExperienceMaintenance("catalog", [], { "repository-id": scope.repositoryId, kind: "jobs", all: true, limit: "37" }, cwd, auth);
  assert.ok("items" in jobs);
  assert.equal(jobs.items.length, 120);
  assert.equal(jobs.nextCursor, null);
  assert.ok(jobs.items.every(job => !("source" in job) && !("claim" in job) && !("leaseUntil" in job)));
  const firstPage = await (await request(`catalog/${scope.repositoryId}?kind=jobs&limit=37`)).json();
  assert.equal((await request(`catalog/${other}?kind=jobs&cursor=${firstPage.nextCursor}`)).status, 400);
  assert.equal((await request(`catalog/${scope.repositoryId}?kind=records&cursor=${firstPage.nextCursor}`)).status, 400);
  assert.equal((await request(`catalog/${"c".repeat(64)}?kind=records`)).status, 404);
  assert.equal((await request(`catalog/${scope.repositoryId}?kind=jobs`, undefined, { "X-Forwarded-For": "127.0.0.1" })).status, 403);
  const empty = await (await request(`catalog/${other}?kind=records`)).json();
  assert.equal(empty.storeAvailable, false);
  console.log("PASS CLI --all reads 120 jobs beyond old 50 limit; repository/cursor/local-only boundaries hold");

  const before = await readFile(path.join(scope.directory, "store.sqlite"));
  await rename(cwd, cwd + "-moved");
  available = false;
  assert.equal((await request(`status?${new URLSearchParams({ cwd })}`)).status, 400);
  for (const [kind, count] of [["records", 1], ["revisions", 3], ["candidates", 1]] as const) {
    const result = await runExperienceMaintenance("catalog", [], { "repository-id": scope.repositoryId, kind, all: true, limit: "1" }, cwd, auth);
    assert.ok("items" in result);
    assert.equal(result.sourceAvailable, false);
    assert.equal(result.items.length, count);
  }
  assert.deepEqual(await readFile(path.join(scope.directory, "store.sqlite")), before);
  console.log("PASS unavailable source remains unavailable; registered archive retains records, all revisions and candidates; SQLite bytes unchanged");
} finally {
  await learning.dispose();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
