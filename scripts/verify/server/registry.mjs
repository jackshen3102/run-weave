// Exercise the real public npm packages in an isolated HOME and prefix.
import { createServer } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  openSync,
  closeSync,
  cpSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { localRegistry, npmCommand } from "./local-registry.mjs";
import { verifyWindowsTerminal } from "./windows-terminal.mjs";

const serverVersion = JSON.parse(
  readFileSync("packages/runweave-server/package.json"),
).version;
const cliVersion = JSON.parse(
  readFileSync("packages/runweave-cli/package.json"),
).version;
const upgradeFrom = process.argv.find(arg => arg.startsWith("--upgrade-from="))?.slice(15);
const smoke = process.argv.includes("--smoke");
const cliTarball = process.argv.find(arg => arg.startsWith("--cli-tarball="))?.slice(14);
if (cliTarball && !path.isAbsolute(cliTarball)) throw new Error("CLI tarball must be an absolute path");
if (upgradeFrom && (upgradeFrom !== "0.1.3" || process.platform !== "linux"))
  throw new Error("Published database upgrade verification supports Linux Server 0.1.3");
const initialVersion = upgradeFrom ?? serverVersion;
const fixture = mkdtempSync(path.join(process.platform === "win32" ? os.homedir() : os.tmpdir(), "rw registry 中文-"));
const home = path.join(fixture, "home"),
  prefix = path.join(fixture, "prefix");
mkdirSync(home, { mode: 0o700 });
const preloader = path.join(fixture, "home.cjs");
writeFileSync(
  preloader,
  `const os=require('node:os');const actual=os.userInfo();os.userInfo=()=>({...actual,homedir:${JSON.stringify(home)}});os.homedir=()=>${JSON.stringify(home)};`,
);
const env = {
  ...process.env,
  HOME: home,
  ...(process.platform === "win32" ? { USERPROFILE: home } : {}),
  NODE_OPTIONS: `--require=${JSON.stringify(preloader)}`,
  npm_config_registry: "https://registry.npmjs.org/",
};
for (const key of Object.keys(env))
  if (
    key.startsWith("RUNWEAVE_") ||
    key.startsWith("PLAYWRIGHT_") ||
    key === "ELECTRON_RUN_AS_NODE" ||
    key === "CODEX_HOME"
  )
    delete env[key];
const assert = (ok, message) => {
  if (!ok) throw new Error(message);
};
function run(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      cwd: fixture,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      timeout: 120_000,
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("error", reject);
    if (input !== undefined) child.stdin.end(input);
    child.on("exit", (code) =>
      code === 0
        ? resolve(stdout)
        : reject(
            new Error(`${command} ${args.slice(0, 3).join(" ")} failed (${code}): ${stdout.slice(-2000)} ${stderr.slice(-4000)}`),
          ),
    );
  });
}
const cliCommand = process.platform === "win32"
  ? [process.execPath, path.join(prefix, "node_modules/@runweave/cli/dist/index.js")]
  : [path.join(prefix, "bin/rw")];
const rw = (...args) => run(cliCommand[0], [...cliCommand.slice(1), "server", ...args]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let foreground, log, registry;
try {
  if (process.argv.includes("--local")) {
    const source = path.resolve(".runtime-artifacts/server");
    let candidate;
    if (process.platform === "win32" && !smoke) {
      candidate = path.join(fixture, "candidate");
      for (const directory of ["package", `${process.platform}-${process.arch}`]) {
        const target = path.join(candidate, directory);
        cpSync(path.join(source, directory), target, { recursive: true, filter: () => true });
        const file = path.join(target, "package.json");
        const pkg = JSON.parse(readFileSync(file, "utf8")); pkg.version = "0.1.999";
        if (pkg.optionalDependencies) pkg.optionalDependencies = Object.fromEntries(Object.keys(pkg.optionalDependencies).map(key => [key, "0.1.999"]));
        writeFileSync(file, JSON.stringify(pkg));
      }
      const file = path.join(candidate, `${process.platform}-${process.arch}`, "manifest.json");
      const manifest = JSON.parse(readFileSync(file, "utf8"));
      assert(manifest.databaseUpgradeFrom?.includes("394f073cb4bf3a05cfece55e92fbd68b0013e0ce2581c350fabb2f2c228ffd26"),
        "Built Windows release does not declare the reviewed Server 0.1.7 database upgrade");
      manifest.version = "0.1.999";
      // Exercise the declared one-way database bridge through the real foreground updater and PTY Host.
      manifest.databaseUpgradeFrom = [manifest.databaseCompatibility];
      manifest.databaseCompatibility = "a".repeat(64);
      writeFileSync(file, JSON.stringify(manifest));
    }
    registry = await localRegistry(source, fixture, candidate);
    env.npm_config_registry = registry.url;
  }
  await run(npmCommand[0], [...npmCommand.slice(1),
    "install",
    "-g",
    "--prefix",
    prefix,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    cliTarball ?? `@runweave/cli@${cliVersion}`,
    ...upgradeFrom ? [] : [`@runweave/server@${serverVersion}`],
  ]);
  if (upgradeFrom) await run(npmCommand[0], [...npmCommand.slice(1), "install", "-g", "--prefix", prefix,
    "--ignore-scripts", "--no-audit", "--no-fund", "--registry", "https://registry.npmjs.org/",
    `@runweave/server@${upgradeFrom}`]);
  if (process.platform === "win32") {
    console.log("Verify Windows native file lock");
    const nativeLock = path.join(prefix, "node_modules/@runweave/cli/node_modules/fs-native-extensions");
    await run(process.execPath, ["-e", `const fs=require('node:fs'); const lock=require(${JSON.stringify(nativeLock)}); const fd=fs.openSync('probe.lock','a+'); if (!lock.tryLock(fd)) throw new Error('Native file lock unavailable'); fs.closeSync(fd);`]);
  }
  const auth = {
    username: "registry-verification",
    password: randomBytes(24).toString("hex"),
  };
  const authFile = path.join(fixture, "auth.json");
  writeFileSync(authFile, JSON.stringify(auth), { mode: 0o600 });
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  console.log("Verify Server initialization");
  await rw(
    "init",
    "--auth-file",
    authFile,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
  );
  if (process.platform === "win32") {
    console.log("Verify PowerShell .cmd entry points");
    for (const shim of [path.join(prefix, "rw.cmd"), path.join(home, ".runweave/server/rw.cmd")]) {
      const command = `& '${shim.replaceAll("'", "''")}' --version\nexit $LASTEXITCODE`;
      const version = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")]);
      assert(version.trim() === cliVersion, `Wrong CLI version from ${shim}`);
    }
  }
  console.log("Verify native runtime loading");
  assert(
    JSON.parse(await rw("doctor", "--json")).runtimeReady,
    "Native runtime not ready",
  );
  if (process.platform === "win32") {
    const serverHome = path.join(home, ".runweave/server");
    const pointer = JSON.parse(readFileSync(path.join(serverHome, "active-release.json"), "utf8"));
    let rejected = false;
    try { await run(process.execPath, [path.join(serverHome, pointer.release, "server/index.cjs"), "component", "app-server"]); }
    catch (error) { rejected = error.message.includes("SERVER_CLI_INCOMPATIBLE"); }
    assert(rejected, "Unmanaged/legacy Windows component must require the compatible outer CLI");
  }
  log = openSync(path.join(fixture, "foreground.log"), "a");
  console.log("Verify foreground startup and health");
  foreground = spawn(cliCommand[0], [...cliCommand.slice(1), "server", "start"], {
    env,
    cwd: fixture,
    stdio: ["ignore", log, log],
  });
  let spawnError;
  foreground.on("error", (error) => {
    spawnError = error;
  });
  let status;
  const healthDeadline = Date.now() + 120_000;
  while (Date.now() < healthDeadline) {
    if (spawnError) throw spawnError;
    assert(foreground.exitCode === null, "Foreground exited; see fixture log");
    status = JSON.parse(await rw("status", "--json"));
    if (status.healthy) break;
    await sleep(300);
  }
  assert(
    status?.healthy &&
      status.runningVersion === initialVersion &&
      status.installedVersion === initialVersion,
    `Wrong/unhealthy running release: ${JSON.stringify(status)}`,
  );
  const url = `http://127.0.0.1:${port}`;
  console.log("Verify bundled web and login");
  assert((await fetch(url, { signal: AbortSignal.timeout(30_000) })).ok, "Bundled web page unavailable");
  const response = await fetch(`${url}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-auth-client": "app" },
    body: JSON.stringify(auth),
    signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok, `Login failed (${response.status})`);
  const session = await response.json();
  const verified = await fetch(`${url}/api/auth/verify`, {
    headers: { authorization: `Bearer ${session.accessToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  assert(verified.ok, "Authenticated request failed");
  if (upgradeFrom) {
    console.log(`Verify published Server ${upgradeFrom} upgrade and explicit task migration`);
    const headers = { "content-type": "application/json", authorization: `Bearer ${session.accessToken}` };
    const api = async (route, body, extraHeaders = {}) => {
      const response = await fetch(`${url}${route}`, {
        method: body === undefined ? "GET" : "POST", headers: { ...headers, ...extraHeaders },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
      });
      assert(response.ok, `${route} failed (${response.status}): ${await response.clone().text()}`);
      return response.json();
    };
    const project = await api("/api/terminal/project", { name: "published upgrade", path: fixture });
    const config = {
      name: "preserve old task", projectId: project.projectId, provider: "codex", prompt: "Preserve this original prompt.",
      schedule: { kind: "once", timezone: "UTC", runAt: "2100-01-01T00:00:00.000Z" },
      misfirePolicy: { mode: "skip" },
    };
    const createdAt = "2026-01-01T00:00:00.000Z";
    const task = { ...config, id: randomUUID(), revision: 1, enabled: true, nextRunAt: config.schedule.runAt,
      createdAt, updatedAt: createdAt, deletedAt: null };
    const oldRun = { id: randomUUID(), taskId: task.id, taskRevision: task.revision, snapshot: config, trigger: "manual",
      scheduledFor: createdAt, dispatch: null, status: "completed", startedAt: createdAt, finishedAt: createdAt,
      summary: "original result", error: null, artifacts: [], outputCursor: "15", executionProjectId: project.projectId,
      cwd: fixture, threadRef: { provider: "codex", threadId: "original-thread" }, recoverable: true, terminalBinding: null };
    const storage = JSON.parse(await run(cliCommand[0], [...cliCommand.slice(1), "config", "explain",
      "storage.scheduledTasksDirectory", "--instance", "stable", "--json"]));
    const databaseFile = path.join(storage.resolved.value, "scheduled-tasks.sqlite");
    const current = path.join(home, ".runweave/server/current");
    const Database = createRequire(path.join(current, "backend/index.cjs"))("better-sqlite3");
    // Seed prior user data in this isolated fixture without requiring a provider login or executing an Agent.
    const seed = new Database(databaseFile);
    try {
      seed.transaction(() => {
        seed.prepare("INSERT INTO scheduled_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(task.id, task.revision, project.projectId, project.projectId, task.name, 1, task.nextRunAt, null, JSON.stringify(task));
        seed.prepare("INSERT INTO scheduled_runs(id,task_id,status,trigger_kind,scheduled_for,occurrence_key,created_at,payload_json) VALUES (?,?,?,?,?,?,?,?)")
          .run(oldRun.id, task.id, oldRun.status, oldRun.trigger, createdAt, "published-occurrence", createdAt, JSON.stringify(oldRun));
        seed.prepare("INSERT INTO scheduled_run_output_chunks VALUES (?, ?, ?)").run(oldRun.id, 15, Buffer.from("original output"));
        seed.prepare("INSERT INTO scheduled_idempotency VALUES (?, ?, ?, ?, ?)")
          .run("create-task", "original-key", "original-hash", task.id, createdAt);
      }).immediate();
    } finally { seed.close(); }
    assert((await api(`/api/scheduled-tasks/${task.id}`)).prompt === task.prompt, "Old Backend could not read the seeded v4 task");
    const snapshot = (file = databaseFile) => {
      const db = new Database(file, { readonly: true });
      try {
        return db.transaction(() => ({ version: db.pragma("user_version", { simple: true }),
          records: db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'scheduled_%' ORDER BY name").all()
            .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]),
        }))();
      } finally { db.close(); }
    };
    const before = snapshot();
    assert(before.version === 4, "Published source did not create the expected v4 database");
    const sourcePackage = path.join(fixture, "published-server-source");
    cpSync(path.join(prefix, "lib/node_modules/@runweave/server"), sourcePackage, { recursive: true });
    const beforePid = status.backend.pid;
    const preview = JSON.parse(await rw("update", "--version", serverVersion, "--dry-run"));
    assert(preview.databaseCompatible && JSON.parse(await rw("status", "--json")).backend.pid === beforePid,
      "Upgrade preview failed or stopped the old Backend");
    await rw("update", "--version", serverVersion);
    status = JSON.parse(await rw("status", "--json"));
    assert(status.healthy && status.runningVersion === serverVersion && status.backend.pid !== beforePid,
      "Published source did not upgrade to the built Server");
    assert(JSON.stringify(snapshot()) === JSON.stringify(before), "Backend upgrade changed the old task database before explicit migration");
    const capabilities = await api("/api/scheduled-tasks/capabilities");
    assert(capabilities.taskContextVersion === 2 && capabilities.enabled === false && capabilities.reason.includes("migration_required"),
      "New Backend did not expose the pending migration safely");
    await run(cliCommand[0], [...cliCommand.slice(1), "auth", "login", "--instance", "stable",
      "--base-url", url, "--username", auth.username, "--json"], auth.password + "\n");
    const tasks = (...args) => run(cliCommand[0], [...cliCommand.slice(1), "scheduled-task", ...args, "--instance", "stable", "--json"]);
    const draftFile = path.join(fixture, "migration.json");
    const migrationPreview = JSON.parse(await tasks("migration", "preview", "--file", draftFile));
    assert(migrationPreview.preview.tasks.length === 1 && migrationPreview.preview.tasks[0].id === task.id
      && migrationPreview.preview.tasks[0].originalPrompt === task.prompt && migrationPreview.preview.tasks[0].enabled,
      "Migration preview lost the old task or its original state");
    assert(JSON.stringify(snapshot()) === JSON.stringify(before), "Migration preview wrote the task database");
    const migrationArgs = ["migration", "apply", "--file", draftFile, "--sha256", migrationPreview.sha256,
      "--expected-backend", migrationPreview.backend, "--idempotency-key", "published-upgrade-migration"];
    const receipt = JSON.parse(await tasks(...migrationArgs));
    assert(receipt.sourceVersion === 4 && receipt.targetVersion === 5 && receipt.restartRequired
      && JSON.stringify(snapshot(receipt.backupPath)) === JSON.stringify(before), "Migration did not preserve a complete old database backup");
    assert(JSON.stringify(JSON.parse(await tasks(...migrationArgs))) === JSON.stringify(receipt), "Migration replay changed the receipt");
    await rw("restart");
    const migrated = JSON.parse(await tasks("get", task.id));
    assert(migrated.id === task.id && migrated.revision === task.revision + 1 && migrated.prompt.startsWith(task.prompt)
      && !migrated.enabled && migrated.nextRunAt === null && !("projectId" in migrated), "Migrated task was lost, enabled or kept its old project binding");
    const migratedRun = JSON.parse(await tasks("run", "get", oldRun.id));
    assert(migratedRun.threadRef.threadId === oldRun.threadRef.threadId && migratedRun.summary === oldRun.summary
      && migratedRun.executionContext.kind === "project" && migratedRun.executionContext.cwd === fixture
      && migratedRun.executionContext.projectId === project.projectId, "Migration lost the historical run or its execution context");
    assert(JSON.parse(await tasks("run", "output", oldRun.id, "--cursor", "0")).text === "original output", "Migration lost historical output");
    assert((await api("/api/scheduled-tasks/capabilities")).enabled, "Task subsystem did not recover after migration and restart");
    let rollbackRejected = false;
    try { await rw("update", "--server-package", sourcePackage, "--dry-run"); }
    catch (error) { assert(error.message.includes("SERVER_DATA_INCOMPATIBLE"), error.message); rollbackRejected = true; }
    assert(rollbackRejected && JSON.parse(await rw("status", "--json")).healthy, "One-way upgrade allowed rollback to the old database writer");
    console.log("Published v4 upgrade, read-only previews, explicit migration, backup, replay and rollback rejection verified");
  }
  console.log("Login verified; verify terminal runtime");
  const terminal = process.platform === "win32"
    ? await verifyWindowsTerminal(url, session.accessToken, home, smoke ? undefined : {
      rw, cliEntry: cliCommand[1], local: process.argv.includes("--local"),
      async restartAfterCrash() {
        const before = JSON.parse(await rw("status", "--json"));
        console.log("Force Backend exit", JSON.stringify({ pid: before.backend.pid, startedAt: before.backend.startedAt }));
        process.kill(before.backend.pid, "SIGKILL");
        for (let i = 0; i < 600 && foreground.exitCode === null; i++) await sleep(100);
        assert(foreground.exitCode !== null, "Manager did not release failed Backend");
        foreground = spawn(cliCommand[0], [...cliCommand.slice(1), "server", "start"], { env, cwd: fixture, stdio: ["ignore", log, log] });
        foreground.on("error", error => { spawnError = error; });
        const until = Date.now() + 120000;
        while (Date.now() < until) {
          if (spawnError) throw spawnError;
          assert(foreground.exitCode === null, "Replacement manager exited");
          if (JSON.parse(await rw("status", "--json")).healthy) return;
          await sleep(300);
        }
        throw new Error("Backend crash recovery timed out");
      },
    }) : null;
  console.log(
    JSON.stringify({
      platform: `${process.platform}-${process.arch}`,
      serverVersion,
      cliVersion,
      ...(upgradeFrom ? { upgradeFrom, taskMigrationVerified: true } : {}),
      healthy: true,
      loginVerified: true,
      terminal,
      fixture,
    }),
  );
} catch (error) {
  if (log !== undefined) process.stderr.write(readFileSync(path.join(fixture, "foreground.log"), "utf8").slice(-16000));
  throw error;
} finally {
  if (foreground?.exitCode === null) {
    await rw("stop").catch(() => foreground.kill("SIGTERM"));
    for (let i = 0; i < 50 && foreground.exitCode === null; i++)
      await sleep(100);
    assert(
      foreground.exitCode !== null,
      `Verification process did not stop: ${fixture}`,
    );
  }
  if (process.platform === "win32") await rw("host", "stop").catch(() => {});
  if (log !== undefined) closeSync(log);
  await registry?.close();
}
