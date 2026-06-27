import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliEntry = path.join(repoRoot, "packages", "runweave-cli", "dist", "index.js");

await run("pnpm", ["--filter", "@runweave/cli", "build"]);

await verifyStatusDoesNotStart();
await verifyStartFailsWithoutRuntime();
await verifyInstallStartsAndStops();
await verifyReusesOwner();
await verifyRestartKeepsRuntime();
await verifyRestartStopsLegacyLockOwner();
await verifyStaleLock();
await verifyConcurrentStart();
await verifyBadInstallFails();

console.log("app-server CLI start verification passed");

async function verifyStatusDoesNotStart() {
  const home = await mkdtemp(path.join(os.tmpdir(), "runweave-cli-status-"));
  try {
    const status = await runCli(["app-server", "status"], { home });
    assert.equal(status.code, 0);
    assert.equal(status.json.available, false);
    assert.equal(status.json.currentRuntime, null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function verifyStartFailsWithoutRuntime() {
  const home = await mkdtemp(path.join(os.tmpdir(), "runweave-cli-no-runtime-"));
  try {
    const start = await runCli(["app-server", "start"], { home });
    assert.equal(start.code, 1);
    assert.equal(start.json.started, false);
    assert.match(start.json.error, /global runtime is not installed/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function verifyInstallStartsAndStops() {
  const home = await mkdtemp(path.join(os.tmpdir(), "runweave-cli-start-"));
  try {
    await installRuntime(home, "verify-start");
    const start = await runCli(["app-server", "start"], { home });
    assert.equal(start.code, 0);
    assert.equal(start.json.started, true);
    assert.equal(start.json.lock.source, "global");
    assert.equal(start.json.lock.releaseId, "verify-start");
    assert.ok(start.json.lock.entry.includes("verify-start"));
    await assertTokenRedacted(home, [start.stdout, JSON.stringify(start.json)]);

    const stop = await runCli(["app-server", "stop"], { home });
    assert.equal(stop.code, 0);
    assert.equal(stop.json.stopped, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function verifyReusesOwner() {
  const home = await mkdtemp(path.join(os.tmpdir(), "runweave-cli-reuse-"));
  try {
    await installRuntime(home, "verify-reuse");
    const first = await runCli(["app-server", "start"], { home });
    const second = await runCli(["app-server", "start"], { home });
    assert.equal(first.code, 0);
    assert.equal(second.code, 0);
    assert.equal(second.json.baseUrl, first.json.baseUrl);
    assert.equal(second.json.pid, first.json.pid);
    await stopStatusOwner(second.json);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function verifyRestartKeepsRuntime() {
  const home = await mkdtemp(path.join(os.tmpdir(), "runweave-cli-restart-"));
  try {
    await installRuntime(home, "verify-restart");
    const first = await runCli(["app-server", "start"], { home });
    const restarted = await runCli(["app-server", "restart"], { home });
    assert.equal(first.code, 0);
    assert.equal(restarted.code, 0);
    assert.equal(restarted.json.started, true);
    assert.equal(restarted.json.lock.releaseId, "verify-restart");
    assert.notEqual(restarted.json.pid, first.json.pid);
    await stopStatusOwner(restarted.json);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function verifyRestartStopsLegacyLockOwner() {
  const home = await mkdtemp(path.join(os.tmpdir(), "runweave-cli-legacy-lock-"));
  try {
    await installRuntime(home, "verify-legacy-current");
    const first = await runCli(["app-server", "start"], { home });
    assert.equal(first.code, 0);
    assert.equal(first.json.started, true);
    const oldPid = first.json.pid;

    await writeFile(
      path.join(home, "app-server.lock.json"),
      JSON.stringify(
        {
          pid: first.json.lock.pid,
          host: first.json.lock.host,
          port: first.json.lock.port,
          startedAt: first.json.lock.startedAt,
          version: first.json.lock.version,
        },
        null,
        2,
      ),
    );

    await installRuntime(home, "verify-legacy-next");
    const restarted = await runCli(["app-server", "restart"], { home });
    assert.equal(restarted.code, 0);
    assert.equal(restarted.json.started, true);
    assert.equal(restarted.json.lock.releaseId, "verify-legacy-next");
    assert.notEqual(restarted.json.pid, oldPid);
    assert.equal(isPidAlive(oldPid), false);
    await stopStatusOwner(restarted.json);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function verifyStaleLock() {
  const home = await mkdtemp(path.join(os.tmpdir(), "runweave-cli-stale-"));
  try {
    await installRuntime(home, "verify-stale");
    await writeFile(
      path.join(home, "app-server.lock.json"),
      JSON.stringify(
        {
          pid: 999999,
          host: "127.0.0.1",
          port: 9,
          startedAt: new Date().toISOString(),
          version: "0.1.0",
          source: "global",
          releaseId: "verify-stale",
          entry: path.join(home, "runtime", "releases", "verify-stale", "app-server", "index.cjs"),
          runtimeRoot: path.join(home, "runtime"),
        },
        null,
        2,
      ),
    );
    await writeFile(path.join(home, "app-server-token"), "stale-token\n");

    const start = await runCli(["app-server", "start"], { home });
    assert.equal(start.code, 0);
    assert.notEqual(start.json.pid, 999999);
    await stopStatusOwner(start.json);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function verifyConcurrentStart() {
  const home = await mkdtemp(path.join(os.tmpdir(), "runweave-cli-concurrent-"));
  try {
    await installRuntime(home, "verify-concurrent");
    const results = await Promise.all(
      Array.from({ length: 5 }, () => runCli(["app-server", "start"], { home })),
    );
    assert.equal(results.every((result) => result.code === 0), true);
    assert.equal(new Set(results.map((result) => result.json.baseUrl)).size, 1);
    await stopStatusOwner(results[0].json);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function verifyBadInstallFails() {
  const home = await mkdtemp(path.join(os.tmpdir(), "runweave-cli-bad-install-"));
  try {
    const install = await runCli(
      [
        "app-server",
        "install",
        "--entry",
        path.join(home, "missing.cjs"),
        "--release-id",
        "bad-install",
      ],
      { home },
    );
    assert.equal(install.code, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function installRuntime(home, releaseId) {
  await run("node", [
    "scripts/install-app-server-runtime.mjs",
    `--home=${home}`,
    `--release-id=${releaseId}`,
  ]);
}

async function assertTokenRedacted(home, outputs) {
  const token = (await readFile(path.join(home, "app-server-token"), "utf8")).trim();
  assert.ok(token);
  for (const output of outputs) {
    assert.equal(output.includes(token), false);
  }
}

function runCli(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        RUNWEAVE_APP_SERVER_HOME: options.home,
      },
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
    child.on("close", (code) => {
      const json = stdout.trim() ? JSON.parse(stdout) : null;
      resolve({ code, json, stderr, stdout });
    });
  });
}

async function stopStatusOwner(status) {
  if (typeof status.pid !== "number") {
    return;
  }
  try {
    process.kill(status.pid, "SIGTERM");
  } catch {
    return;
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!isPidAlive(status.pid)) {
      return;
    }
    await delay(100);
  }
  try {
    process.kill(status.pid, "SIGKILL");
  } catch {
    // The process may have exited between polls.
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function run(command, args) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
  });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}
