// Exercise the real public npm packages in an isolated HOME and prefix.
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
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
    key === "ELECTRON_RUN_AS_NODE" ||
    key === "CODEX_HOME"
  )
    delete env[key];
const assert = (ok, message) => {
  if (!ok) throw new Error(message);
};
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      cwd: fixture,
      stdio: ["ignore", "pipe", "pipe"],
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
    if (process.platform === "win32") {
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
    `@runweave/cli@${cliVersion}`,
    `@runweave/server@${serverVersion}`,
  ]);
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
      status.runningVersion === serverVersion &&
      status.installedVersion === serverVersion,
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
  console.log("Login verified; verify terminal runtime");
  const terminal = process.platform === "win32"
    ? await verifyWindowsTerminal(url, session.accessToken, home, {
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
