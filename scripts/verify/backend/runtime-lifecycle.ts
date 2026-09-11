import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ActivityRuntime } from "../../../backend/src/activity/runtime";
import { ActivityStore } from "../../../backend/src/activity/recording/store";
import { createRuntimeServices } from "../../../backend/src/bootstrap/runtime-services";
import type { SqliteEvolutionActivationStore } from "../../../backend/src/evolution/storage/store";
import { runProviderProcess } from "../../../backend/src/evolution/providers/process-runner";

// Integration verification: real SQLite workers, persistence, tmux and runtime
// owners. No HTTP product server or installed runtime is started by this script.
let root: string;
const originalEnv = { ...process.env };
const checks: string[] = [];

function isolate(name: string, channel = "dev"): string {
  const directory = path.join(root, name);
  Object.assign(process.env, {
    NODE_ENV: "development",
    ELECTRON_RUN_AS_NODE: "",
    RUNWEAVE_RUNTIME_RELEASE_ID: "",
    RUNWEAVE_DESKTOP_CHANNEL: channel,
    BROWSER_PROFILE_DIR: directory,
    RUNWEAVE_DEV_BROWSER_PROFILE_DIR: directory,
    AUTH_STORE_FILE: path.join(directory, "auth.json"),
    TERMINAL_SESSION_STORE_FILE: path.join(directory, "sessions.json"),
    RUNWEAVE_ACTIVITY_TEST_MODE: "true",
    RUNWEAVE_ACTIVITY_HOME: path.join(directory, "activity"),
    RUNWEAVE_EVOLUTION_TEST_MODE: "true",
    RUNWEAVE_EVOLUTION_HOME: path.join(directory, "evolution"),
    RUNWEAVE_APP_SERVER_DISCOVERY: "disabled",
    RUNWEAVE_ACTIVITY_WORKER_ENTRY: "",
    RUNWEAVE_EVOLUTION_WORKER_ENTRY: "",
    TERMINAL_TMUX_SOCKET_PATH: path.join(directory, "tmux.sock"),
    TERMINAL_TMUX_SCAN_ORPHANS_ON_START: "false",
    TERMINAL_TMUX_CLEANUP_ORPHANS: "false",
  });
  return directory;
}

async function verifyActivityDrain(): Promise<void> {
  const directory = isolate("activity-drain");
  const runtime = await ActivityRuntime.create({
    env: process.env,
    browserProfileDir: directory,
    runtimeChannel: "dev",
  });
  assert(runtime.store);
  const store = runtime.store;
  const scope = { projectId: "lifecycle-delete" };
  await store.record([
    runtime.eventFactory.create({
      eventName: "terminal.session.created",
      scope,
    }),
  ]);
  const job = await store.createDeleteJob({
    requestId: crypto.randomUUID(),
    backendInstanceId: runtime.instanceId,
    authSubjectHmac: await store.auditSubjectHmac("lifecycle-verifier"),
    scope,
    snapshot: await store.preview(scope),
  });
  const order: string[] = [];
  const runDelete = store.runDelete.bind(store);
  const close = store.close.bind(store);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const requested = new Promise<void>((resolve) => {
    entered = resolve;
  });
  store.runDelete = async (...args) => {
    order.push("delete-request");
    const result = await runDelete(...args);
    entered();
    await barrier;
    order.push("delete-completed");
    return result;
  };
  store.close = async () => {
    order.push("store-close");
    await close();
  };
  try {
    runtime.start();
    runtime.start();
    await requested;
    const first = runtime.dispose();
    assert.equal(runtime.dispose(), first);
    assert.deepEqual(order, ["delete-request"]);
    release();
    await first;
    runtime.start();
    await runtime.dispose();
    assert.deepEqual(order, [
      "delete-request",
      "delete-completed",
      "store-close",
    ]);
  } finally {
    release();
    await runtime.dispose();
  }
  const reopened = await ActivityStore.create({
    databasePath: path.join(directory, "activity", "activity.sqlite"),
    env: process.env,
  });
  try {
    assert(await reopened.integrity());
    let current = await reopened.deleteStatus(job.deleteJobId);
    for (let i = 0; current?.status !== "completed" && i < 10; i++) {
      current = await reopened.runDelete(
        `${runtime.instanceId}:recovery`,
        Date.now() + 60_000,
      );
    }
    assert.equal(current?.status, "completed");
    assert.equal((await reopened.facts(scope)).facts.length, 0);
    assert(
      (await reopened.facts({ eventName: "producer.instance.started" })).facts
        .length > 0,
    );
  } finally {
    await reopened.close();
  }
  checks.push(
    "BRL-002: real maintenance drained before close; deletion durable; dispose idempotent",
  );
}

async function verifyChannel(
  channel: "stable" | "dev" | "beta",
): Promise<void> {
  isolate(`channel-${channel}`, channel);
  const runtime = await createRuntimeServices(`lifecycle:${channel}`);
  const socket = runtime.tmuxService.socketPath;
  try {
    execFileSync("tmux", [
      "-S",
      socket,
      "new-session",
      "-d",
      "-s",
      "lifecycle",
      "sleep 120",
    ]);
    runtime.start("http://127.0.0.1:1");
    const first = runtime.dispose();
    assert.equal(runtime.dispose(), first);
    await first;
    let survived = true;
    try {
      execFileSync("tmux", ["-S", socket, "has-session", "-t", "lifecycle"], {
        stdio: "ignore",
      });
    } catch {
      survived = false;
    }
    assert.equal(survived, channel === "stable");
    checks.push(`BRL-007: ${channel} owned tmux preservation=${survived}`);
  } finally {
    await runtime.dispose();
    try {
      execFileSync("tmux", ["-S", socket, "kill-server"], { stdio: "ignore" });
    } catch {
      /* already stopped */
    }
  }
}

async function verifyEvolutionDrain(): Promise<void> {
  isolate("evolution-drain");
  const runtime = await createRuntimeServices("lifecycle:evolution-drain");
  const store =
    runtime.evolutionActivationStore as SqliteEvolutionActivationStore;
  const order: string[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const requested = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const recover = store.recoverExpiredRuns.bind(store);
  const close = store.close.bind(store);
  store.recoverExpiredRuns = async (...args) => {
    const result = await recover(...args);
    order.push("maintenance-request");
    entered();
    await barrier;
    order.push("maintenance-completed");
    return result;
  };
  store.close = async () => {
    order.push("store-close");
    await close();
  };
  try {
    runtime.start("http://127.0.0.1:1");
    await requested;
    const closing = runtime.dispose();
    assert.deepEqual(order, ["maintenance-request"]);
    release();
    await closing;
    runtime.start("http://127.0.0.1:1");
    assert.deepEqual(order, [
      "maintenance-request",
      "maintenance-completed",
      "store-close",
    ]);
    checks.push(
      "BRL-005: real Evolution maintenance drained before storage close; no restart after dispose",
    );
  } finally {
    release();
    await runtime.dispose();
  }
}

async function verifyCleanupFailure(): Promise<void> {
  isolate("cleanup-failure");
  const runtime = await createRuntimeServices("lifecycle:cleanup-failure");
  const order: string[] = [];
  const workspaceDispose = runtime.workspaceServiceManager.dispose.bind(
    runtime.workspaceServiceManager,
  );
  runtime.workspaceServiceManager.dispose = async () => {
    await workspaceDispose();
    order.push("workspace-disposed");
    throw new Error("lifecycle injected post-dispose failure");
  };
  assert(runtime.activityStore);
  const storeClose = runtime.activityStore.close.bind(runtime.activityStore);
  runtime.activityStore.close = async () => {
    await storeClose();
    order.push("activity-closed");
  };
  runtime.start("http://127.0.0.1:1");
  const first = runtime.dispose();
  assert.equal(runtime.dispose(), first);
  await assert.rejects(first, (error: unknown) => {
    assert(error instanceof AggregateError);
    assert(
      error.errors.some((entry: Error) =>
        entry.message.includes("workspace-services"),
      ),
    );
    return true;
  });
  assert.deepEqual(order, ["workspace-disposed", "activity-closed"]);
  checks.push(
    "BRL-005: real cleanup continues after failure; concurrent dispose shares completion",
  );
}

async function verifyProviderCancellation(): Promise<void> {
  const directory = await mkdtemp(path.join(root, "provider-cancel-"));
  const marker = path.join(directory, "started");
  const fixture = path.join(directory, "provider.cjs");
  await writeFile(
    fixture,
    `
    const fs = require("node:fs");
    process.on("SIGTERM", () => process.exit(143));
    process.stdin.resume();
    fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));
    setInterval(() => {}, 1000);
  `,
  );
  const request = {
    prompt: "local cancellation fixture",
    workingDirectory: directory,
    outputSchemaPath: path.join(directory, "schema.json"),
    maxWallTimeMs: 10_000,
    maxOutputBytes: 4_096,
  };
  const run = (signal: AbortSignal) =>
    runProviderProcess({
      provider: "codex",
      binary: process.execPath,
      args: [fixture],
      request: { ...request, signal },
    });
  const cancelled = new AbortController();
  cancelled.abort("evolution_runtime_shutdown");
  await assert.rejects(run(cancelled.signal), /provider_cancelled/);
  assert.equal(await readFile(marker, "utf8").catch(() => null), null);

  const active = new AbortController();
  const running = run(active.signal).catch((error: unknown) => error);
  try {
    const deadline = Date.now() + 5_000;
    while (!(await readFile(marker, "utf8").catch(() => null))) {
      assert(Date.now() < deadline, "real Provider fixture did not start");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    active.abort("evolution_runtime_shutdown");
    const error = await running;
    assert(error instanceof Error);
    assert.equal(error.message, "provider_cancelled");
    const pid = Number(await readFile(marker, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    active.abort();
    await running;
  }
  checks.push(
    "IPS-003: pre-cancelled request does not spawn; running real Provider exits on abort",
  );
}

async function main(): Promise<void> {
  root = await mkdtemp(path.join(os.tmpdir(), "rw-lifecycle-"));
  try {
    await verifyActivityDrain();
    for (const channel of ["stable", "dev", "beta"] as const)
      await verifyChannel(channel);
    await verifyEvolutionDrain();
    await verifyCleanupFailure();
    await verifyProviderCancellation();
    console.log(JSON.stringify({ ok: true, checks }, null, 2));
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    await rm(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
