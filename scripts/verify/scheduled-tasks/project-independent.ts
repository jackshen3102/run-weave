import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, rename, symlink } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import type { ScheduledTaskCapabilities, CreateScheduledTaskRequest } from "@runweave/shared/scheduled-tasks";
import { ScheduledTaskService } from "../../../backend/src/scheduled-tasks/service";
import { ScheduledTaskRuntime } from "../../../backend/src/scheduled-tasks/runtime";
import { ScheduledTaskStore } from "../../../backend/src/scheduled-tasks/storage/store";
import { createCorsMiddleware } from "../../../backend/src/server/cors";
import { createScheduledTasksRouter } from "../../../backend/src/routes/scheduled-tasks";
import { validateExecutionContext } from "../../../backend/src/scheduled-tasks/execution-context";
import type { TerminalSessionManager } from "../../../backend/src/terminal/manager/manager";
import { codexScheduledEnvironment } from "../../../backend/src/scheduled-tasks/providers/codex";

const requireBackend = createRequire(new URL("../../../backend/package.json", import.meta.url));

/** Actual router, service, worker, SQLite and scheduler; controlled provider only for deterministic boundaries. */
export async function verifyProjectIndependent(store: ScheduledTaskStore): Promise<void> {
  const manager = { getProject: () => { throw new Error("ordinary task queried a project"); } } as unknown as TerminalSessionManager;
  const capabilities: ScheduledTaskCapabilities = { taskContextVersion: 2, enabled: true,
    providers: [{ provider: "codex", available: true, executionPolicies: ["sandbox", "full-access"], continuation: true }],
    limits: { maxConcurrentRuns: 2, timeoutMs: 10000, maxOutputBytes: 10000 } };
  const service = new ScheduledTaskService(store, manager, capabilities);
  const express = requireBackend("express") as typeof import("express");
  const app = express();
  app.use(createCorsMiddleware(["runweave://app"]));
  app.use(express.json());
  app.use("/api/scheduled-tasks", createScheduledTasksRouter(service));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/scheduled-tasks`;
  const draft: CreateScheduledTaskRequest = { name: "project independent integration", provider: "codex", prompt: "write marker",
    schedule: { kind: "daily", timezone: "UTC", localTime: "09:00" }, misfirePolicy: { mode: "skip" }, enabled: false };
  const request = (route: string, body: unknown, key = crypto.randomUUID(), version = "2", method = "POST") => fetch(base + route, {
    method, headers: { "Content-Type": "application/json", "X-Runweave-Task-Context-Version": version, "Idempotency-Key": key }, body: JSON.stringify(body),
  });
  let invocations = 0;
  const runtime = new ScheduledTaskRuntime(store, manager, new Map([["codex", { provider: "codex", run: async (input) => {
    invocations += 1;
    assert.equal(input.projectId, undefined);
    assert.equal(path.basename(input.workingDirectory), input.runId);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(input.workingDirectory, "marker"), input.runId);
    return { provider: "codex", threadId: `fixture-${input.runId}`, summary: "verified", outcome: "succeeded", reason: "" };
  } }]]), true, capabilities.limits);
  try {
    const preflight = await fetch(base + "/capabilities", { method: "OPTIONS", headers: { Origin: "runweave://app", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization,x-runweave-task-context-version" } });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("Access-Control-Allow-Headers")!, /X-Runweave-Task-Context-Version/);
    const validation = await request("/validate-create", draft);
    assert.equal(validation.status, 200);
    assert.equal("project" in await validation.json(), false);
    assert.equal((await store.listTasks()).length, 0);
    for (const invalid of [{ projectId: "old-project" }, { cwd: "/tmp" }, { executionContext: { kind: "task-workspace", cwd: "/tmp" } }]) {
      assert.equal((await request("", { ...draft, ...invalid })).status, 400);
    }
    const created = await request("", draft, "create-once");
    assert.equal(created.status, 201);
    const task = await created.json();
    assert.equal("projectId" in task, false);
    assert.equal((await (await request("", draft, "create-once")).json()).id, task.id);
    assert.equal((await request(`/${task.id}`, { enabled: true, expectedRevision: task.revision }, "old-client", "1", "PATCH")).status, 409);
    assert.equal((await store.getTask(task.id))!.enabled, false);
    assert.equal((await fetch(base + "?projectId=old")).status, 400);
    service.attachRuntime(runtime);
    await runtime.initialize();
    const first = await service.start(task.id, "run-once");
    assert.equal((await service.start(task.id, "run-once")).id, first.id);
    await waitFor(async () => (await store.getRun(first.id))?.status === "completed");
    const second = await service.start(task.id, "run-twice");
    await waitFor(async () => (await store.getRun(second.id))?.status === "completed");
    assert.notEqual(first.executionContext.cwd, second.executionContext.cwd);
    assert.equal(await readFile(path.join(first.executionContext.cwd!, "marker"), "utf8"), first.id);
    assert.equal(await readFile(path.join(second.executionContext.cwd!, "marker"), "utf8"), second.id);
    assert.equal(invocations, 2);
    await rename(first.executionContext.cwd!, `${first.executionContext.cwd}.saved`);
    await assert.rejects(validateExecutionContext((await store.getRun(first.id))!, manager), /私有工作目录不可用/);
    await symlink(second.executionContext.cwd!, first.executionContext.cwd!);
    await assert.rejects(validateExecutionContext((await store.getRun(first.id))!, manager), /私有工作目录不可用/);
    const environment = codexScheduledEnvironment({ RUNWEAVE_PROJECT_ID: "inherited", PLAYWRIGHT_MCP_CDP_ENDPOINT: "http://127.0.0.1:9224?projectId=inherited&groupId=ambient" }, first.id, undefined);
    assert.equal(environment.RUNWEAVE_PROJECT_ID, undefined);
    const endpoint = new URL(environment.PLAYWRIGHT_MCP_CDP_ENDPOINT!);
    assert.equal(endpoint.searchParams.has("projectId"), false);
    assert.equal(endpoint.searchParams.get("groupId"), `browser-group-scheduled-${first.id}`);
  } finally {
    await runtime.dispose();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!await condition()) {
    if (Date.now() > deadline) throw new Error("project independent runtime timeout");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
