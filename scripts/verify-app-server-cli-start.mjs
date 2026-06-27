import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliEntry = path.join(repoRoot, "packages", "runweave-cli", "dist", "index.js");

await run("pnpm", ["--filter", "@runweave/cli", "build"]);

await verifyStatusDoesNotStart();
await verifyStartsWithoutOwner();
await verifyReusesOwner();
await verifyStaleLock();
await verifyConcurrentStart();
await verifyWrongEntryFails();

console.log("app-server CLI start verification passed");

async function verifyStatusDoesNotStart() {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "runweave-cli-status-"));
  try {
    const status = await runCli(["app-server", "status"], { stateDir });
    assert.equal(status.code, 0);
    assert.equal(status.json.available, false);
    assert.equal(status.json.hasToken, false);
    await assertFileMissing(path.join(stateDir, "app-server.lock.json"));
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function verifyStartsWithoutOwner() {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "runweave-cli-start-"));
  try {
    const start = await runCli(["app-server", "start"], { stateDir });
    assert.equal(start.code, 0);
    assert.equal(start.json.started, true);
    const status = await readStatus(stateDir);
    assert.equal(status.available, true);
    assert.equal(status.baseUrl, start.json.baseUrl);
    assert.equal(status.pid, start.json.pid);
    await assertTokenRedacted(stateDir, [start.stdout, JSON.stringify(start.json)]);
    await assertTokenRedacted(stateDir, [JSON.stringify(status)]);
    await stopStatusOwner(status);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function verifyReusesOwner() {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "runweave-cli-reuse-"));
  try {
    const first = await runCli(["app-server", "start"], { stateDir });
    const firstStatus = await readStatus(stateDir);
    const second = await runCli(["app-server", "start"], { stateDir });
    const secondStatus = await readStatus(stateDir);
    assert.equal(first.code, 0);
    assert.equal(second.code, 0);
    assert.equal(second.json.baseUrl, first.json.baseUrl);
    assert.equal(secondStatus.pid, firstStatus.pid);
    await assertTokenRedacted(stateDir, [first.stdout, second.stdout]);
    await stopStatusOwner(secondStatus);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function verifyStaleLock() {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "runweave-cli-stale-"));
  try {
    await writeFile(
      path.join(stateDir, "app-server.lock.json"),
      JSON.stringify(
        {
          pid: 999999,
          host: "127.0.0.1",
          port: 9,
          startedAt: new Date().toISOString(),
          version: "0.1.0",
        },
        null,
        2,
      ),
    );
    await writeFile(path.join(stateDir, "app-server-token"), "stale-token\n");

    const start = await runCli(["app-server", "start"], { stateDir });
    assert.equal(start.code, 0);
    const status = await readStatus(stateDir);
    assert.equal(status.available, true);
    assert.notEqual(status.pid, 999999);
    await assertTokenRedacted(stateDir, [start.stdout, JSON.stringify(status)]);
    await stopStatusOwner(status);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function verifyConcurrentStart() {
  const stateDir = await mkdtemp(
    path.join(os.tmpdir(), "runweave-cli-concurrent-"),
  );
  try {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        runCli(["app-server", "start"], { stateDir }),
      ),
    );
    assert.equal(results.every((result) => result.code === 0), true);
    assert.equal(
      new Set(results.map((result) => result.json.baseUrl)).size,
      1,
    );
    for (const result of results) {
      assert.equal(result.json.started, true);
    }
    const status = await readStatus(stateDir);
    assert.equal(status.available, true);
    await assertTokenRedacted(
      stateDir,
      results.map((result) => result.stdout),
    );
    await stopStatusOwner(status);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function verifyWrongEntryFails() {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "runweave-cli-bad-"));
  try {
    const start = await runCli(["app-server", "start"], {
      extraEnv: {
        RUNWEAVE_CLI_APP_SERVER_ENTRY: path.join(stateDir, "missing-entry.js"),
      },
      stateDir,
    });
    assert.equal(start.code, 1);
    assert.equal(start.json.started, false);
    const status = await readStatus(stateDir);
    assert.equal(status.available, false);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function assertTokenRedacted(stateDir, outputs) {
  const token = (await readFile(path.join(stateDir, "app-server-token"), "utf8"))
    .trim();
  assert.ok(token);
  for (const output of outputs) {
    assert.equal(output.includes(token), false);
  }
}

async function assertFileMissing(filePath) {
  try {
    await access(filePath);
  } catch {
    return;
  }
  assert.fail(`Expected file to be missing: ${filePath}`);
}

async function readStatus(stateDir) {
  const status = await runCli(["app-server", "status"], { stateDir });
  assert.equal(status.code, 0);
  return status.json;
}

function runCli(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...options.extraEnv,
        RUNWEAVE_APP_SERVER_STATE_DIR: options.stateDir,
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
