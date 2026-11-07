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
            new Error(`${command} failed (${code}): ${stderr.slice(-2000)}`),
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
    registry = await localRegistry(path.resolve(".runtime-artifacts/server"), fixture);
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
  await rw(
    "init",
    "--auth-file",
    authFile,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
  );
  assert(
    JSON.parse(await rw("doctor", "--json")).runtimeReady,
    "Native runtime not ready",
  );
  log = openSync(path.join(fixture, "foreground.log"), "a");
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
  for (let i = 0; i < 100; i++) {
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
    "Wrong/unhealthy running release",
  );
  const url = `http://127.0.0.1:${port}`;
  assert((await fetch(url)).ok, "Bundled web page unavailable");
  const response = await fetch(`${url}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-auth-client": "app" },
    body: JSON.stringify(auth),
  });
  assert(response.ok, `Login failed (${response.status})`);
  const session = await response.json();
  const verified = await fetch(`${url}/api/auth/verify`, {
    headers: { authorization: `Bearer ${session.accessToken}` },
  });
  assert(verified.ok, "Authenticated request failed");
  const terminal = process.platform === "win32"
    ? await verifyWindowsTerminal(url, session.accessToken, home) : null;
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
  if (log !== undefined) closeSync(log);
  await registry?.close();
}
