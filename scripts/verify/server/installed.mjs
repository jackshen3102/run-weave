// Real npm tarballs + real Backend/App Server. The loopback registry is a distribution fixture.
// os.userInfo is isolated only in child processes, avoiding the machine's existing Stable registry.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
  openSync,
  closeSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const source = path.resolve(
  process.argv.find((a) => a.startsWith("--artifact="))?.slice(11) ??
    path.join(repo, ".runtime-artifacts/server"),
);
const keepRunning = process.argv.includes("--keep-running");
const fixture = mkdtempSync(path.join("/tmp", "rw-npm-"));
const prefix = path.join(fixture, "prefix"),
  home = path.join(fixture, "home");
mkdirSync(home, { mode: 0o700 });
const preloader = path.join(fixture, "home.cjs");
writeFileSync(
  preloader,
  `const os=require('node:os');const actual=os.userInfo();os.userInfo=()=>({...actual,homedir:${JSON.stringify(home)}});os.homedir=()=>${JSON.stringify(home)};`,
);
const env = {
  ...process.env,
  HOME: home,
  NODE_OPTIONS: `--require=${preloader}`,
};
for (const key of [
  "RUNWEAVE_CONFIG_FILE",
  "RUNWEAVE_DEV_SESSION_ID",
  "ELECTRON_RUN_AS_NODE",
  "NODE_DEBUG",
  "RUNWEAVE_ACCESS_TOKEN",
])
  delete env[key];
const packages = new Map();
const registry = createServer((req, res) => {
  const requested = decodeURIComponent(req.url.split("?")[0]).slice(1);
  for (const [name, versions] of packages) {
    for (const [version, data] of versions)
      if (requested === `${name.replaceAll("/", "-")}-${version}.tgz`) {
        res.setHeader("content-type", "application/octet-stream");
        res.end(data.bytes);
        return;
      }
  }
  const versions = packages.get(requested);
  if (!versions) {
    res.writeHead(404);
    res.end("{}");
    return;
  }
  const metadata = Object.fromEntries(
    [...versions].map(([version, data]) => [
      version,
      {
        ...data.pkg,
        dist: {
          tarball: `${env.npm_config_registry}/${requested.replaceAll("/", "-")}-${version}.tgz`,
          integrity: `sha512-${createHash("sha512").update(data.bytes).digest("base64")}`,
        },
      },
    ]),
  );
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      name: requested,
      "dist-tags": { latest: [...versions.keys()].at(-1) },
      versions: metadata,
    }),
  );
});
await new Promise((resolve) => registry.listen(0, "127.0.0.1", resolve));
env.npm_config_registry = `http://127.0.0.1:${registry.address().port}`;

function pack(directory) {
  const packed = JSON.parse(
    execFileSync(
      "npm",
      ["pack", directory, "--json", "--pack-destination", fixture],
      { encoding: "utf8" },
    ),
  )[0];
  const pkg = JSON.parse(
    readFileSync(path.join(directory, "package.json"), "utf8"),
  );
  if (!packages.has(pkg.name)) packages.set(pkg.name, new Map());
  packages.get(pkg.name).set(pkg.version, {
    pkg,
    bytes: readFileSync(path.join(fixture, packed.filename)),
  });
}
const cliPackage = JSON.parse(
  readFileSync(path.join(source, "cli-package/package.json"), "utf8"),
);
pack(path.join(source, "cli-package"));
env.npm_config_prefix = prefix;
for (const version of ["0.1.0", "0.1.1"]) {
  for (const name of ["package", `${process.platform}-${process.arch}`]) {
    const directory = path.join(fixture, `${name}-${version}`);
    cpSync(path.join(source, name), directory, { recursive: true });
    const file = path.join(directory, "package.json");
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    pkg.version = version;
    if (pkg.optionalDependencies)
      for (const key of Object.keys(pkg.optionalDependencies))
        pkg.optionalDependencies[key] = version;
    writeFileSync(file, JSON.stringify(pkg));
    if (name !== "package") {
      const manifestFile = path.join(directory, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
      manifest.version = version;
      writeFileSync(manifestFile, JSON.stringify(manifest));
    }
    pack(directory);
  }
}
async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: fixture, env, ...options });
    let stdout = "",
      stderr = "";
    child.stdout?.on("data", (data) => {
      stdout += data;
    });
    child.stderr?.on("data", (data) => {
      stderr += data;
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve(stdout)
        : reject(
            new Error(
              `${command} ${args.slice(0, 2).join(" ")} failed (${code}): ${stderr.slice(-2000)}`,
            ),
          ),
    );
  });
}
const cli = (...args) => run(path.join(prefix, "bin/rw"), ["server", ...args]);
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function verifyExistingAppServer(current) {
  const appHome = path.join(home, ".runweave/data/app-server");
  const configArgs = ["--instance", "stable", "--config-dir", path.join(home, ".runweave")];
  await run(path.join(prefix, "bin/rw"), [
    "app-server", "install", "--entry", path.join(current, "app-server/index.cjs"),
    "--release-id", "source-existing", ...configArgs,
  ]);
  const runtimeRoot = path.join(appHome, "runtime");
  const snapshot = (directory) => readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => [entry.name, entry.isDirectory()
      ? snapshot(path.join(directory, entry.name))
      : createHash("sha256").update(readFileSync(path.join(directory, entry.name))).digest("hex")]);
  const before = JSON.stringify(snapshot(runtimeRoot));
  const owner = spawn(process.execPath, [
    path.join(runtimeRoot, "releases/source-existing/app-server/index.cjs"),
    ...configArgs,
  ], { env, cwd: fixture, stdio: "ignore" });
  const exited = new Promise((resolve, reject) => {
    owner.once("exit", resolve);
    owner.once("error", reject);
  });
  try {
    let address;
    for (let attempt = 0; attempt < 100; attempt++) {
      assert(owner.exitCode === null, "Existing App Server exited before readiness");
      try {
        const lock = JSON.parse(readFileSync(path.join(appHome, "app-server.lock.json"), "utf8"));
        address = `http://127.0.0.1:${lock.port}/healthz`;
        const health = await (await fetch(address)).json();
        if (health.pid === owner.pid && health.ok) break;
      } catch { /* Wait for the real source-deployed process. */ }
      address = undefined;
      await sleep(100);
    }
    assert(address, "Existing App Server did not become ready");
    let rejected = false;
    try {
      await run(process.execPath, [path.join(current, "server/index.cjs"), "component", "app-server", ...configArgs]);
    } catch (error) {
      rejected = error.message.includes("CONFIG_INSTANCE_ALREADY_RUNNING");
    }
    assert(rejected, "Server must reject the existing source-deployed owner");
    assert(JSON.stringify(snapshot(runtimeRoot)) === before,
      "Rejected Server changed the existing App Server deployment");
    const health = await (await fetch(address)).json();
    assert(health.pid === owner.pid && health.ok, "Rejected Server disrupted the existing owner");
  } finally {
    owner.kill("SIGTERM");
    await exited;
  }
}
let foreground;
let succeeded = false;
let log;
try {
  await run("npm", [
    "install",
    "-g",
    "--prefix",
    prefix,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    `@runweave/cli@${cliPackage.version}`,
  ]);
  const cliEntry = realpathSync(path.join(prefix, "bin/rw"));
  const cliHash = createHash("sha256")
    .update(readFileSync(cliEntry))
    .digest("hex");
  const cliVersion = await run(path.join(prefix, "bin/rw"), ["--version"]);
  assert(
    JSON.parse(await cli("status", "--json")).installed === false,
    "CLI alone must report that Server is absent",
  );

  await run("npm", [
    "install",
    "-g",
    "--prefix",
    prefix,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "@runweave/server@0.1.0",
  ]);
  assert(
    realpathSync(path.join(prefix, "bin/rw")) === cliEntry,
    "Server installation replaced the rw command owner",
  );
  assert(
    cliEntry.includes("@runweave/cli/"),
    "Only @runweave/cli may provide rw",
  );
  const serverManifest = JSON.parse(
    readFileSync(
      path.join(prefix, "lib/node_modules/@runweave/server/package.json"),
      "utf8",
    ),
  );
  assert(!serverManifest.bin?.rw, "Server must not register rw");
  const activePackage = JSON.parse(await cli("status", "--json"));
  assert(
    activePackage.installedVersion === "0.1.0",
    "Server package discovery failed",
  );
  const current = path.join(home, ".runweave/server/current");
  assert(
    !existsSync(path.join(current, "cli/index.cjs")),
    "Server runtime must not include a CLI copy",
  );
  const doctor = JSON.parse(await cli("doctor", "--json"));
  assert(doctor.runtimeReady, "Native runtime not ready");
  const auth = path.join(fixture, "auth.json");
  writeFileSync(
    auth,
    JSON.stringify({
      username: "npm-fixture",
      password: "Npm-fixture-private-2026!",
    }),
    { mode: 0o600 },
  );
  // Reserve an ephemeral port, then close before the actual Backend starts.
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  await cli("init", "--auth-file", auth, "--port", String(port));
  assert(
    JSON.parse(await cli("init")).changed === false,
    "Init overwrote existing config",
  );
  await verifyExistingAppServer(current);
  log = openSync(path.join(fixture, "foreground.log"), "a");
  foreground = spawn(path.join(prefix, "bin/rw"), ["server", "start"], {
    env,
    cwd: fixture,
    stdio: ["ignore", log, log],
  });
  foreground.on("error", (error) => {
    throw error;
  });
  let status;
  for (let i = 0; i < 100; i++) {
    if (foreground.exitCode !== null)
      throw new Error(
        readFileSync(path.join(fixture, "foreground.log"), "utf8").slice(-3000),
      );
    status = JSON.parse(await cli("status", "--json"));
    if (status.healthy) break;
    await sleep(200);
  }
  assert(status.healthy, "Service did not become healthy");
  const url = `http://127.0.0.1:${port}`;
  assert((await fetch(url)).status === 200, "Bundled web page missing");
  assert(
    (await fetch(url + "/api/server/maintenance", { method: "POST" }))
      .status === 403,
    "Management endpoint accepted missing token",
  );
  const managementToken = readFileSync(
    path.join(home, ".runweave/server/management-token"),
    "utf8",
  );
  const headers = {
    "x-runweave-server-token": managementToken,
    "x-runweave-server-owner": "installed-fixture-owner-1234",
  };
  const lease = await (
    await fetch(url + "/api/server/maintenance", { method: "POST", headers })
  ).json();
  assert(
    lease.leaseId && !lease.affectedRuns.length,
    "Empty service maintenance lease failed",
  );
  assert(
    (
      await fetch(url + `/api/server/maintenance/${lease.leaseId}`, {
        method: "DELETE",
        headers,
      })
    ).status === 204,
    "Lease release failed",
  );
  const login = await (
    await fetch(url + "/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "npm-fixture",
        password: "Npm-fixture-private-2026!",
        clientType: "web",
      }),
    })
  ).json();
  assert(login.accessToken, "API login failed");
  let appService;
  for (let attempt = 0; attempt < 40; attempt++) {
    const runtimeStatus = await (
      await fetch(url + "/api/runtime-status", {
        headers: { authorization: `Bearer ${login.accessToken}` },
      })
    ).json();
    const activity = runtimeStatus.reports
      .flatMap((report) => report.items)
      .find((item) => item.id === "backend.activity-store");
    assert(
      activity?.state === "healthy",
      `Activity unavailable: ${activity?.summary}`,
    );
    appService = runtimeStatus.management.services.find(
      (service) => service.id === "app-server.process",
    );
    if (appService?.state === "healthy") break;
    await sleep(250);
  }
  assert(
    appService?.state === "healthy",
    `App Server business integration unhealthy: ${appService?.summary}`,
  );
  const before = status.backend.pid;
  await cli("restart");
  status = JSON.parse(await cli("status", "--json"));
  assert(
    status.healthy &&
      status.backend.pid !== before &&
      foreground.exitCode === null,
    "Foreground restart failed",
  );
  await cli("update", "--version", "0.1.1");
  status = JSON.parse(await cli("status", "--json"));
  assert(
    status.healthy &&
      status.activeVersion === "0.1.1" &&
      status.installedVersion === "0.1.1" &&
      status.runningVersion === "0.1.1" &&
      foreground.exitCode === null,
    "NPM update did not activate coherently in the original foreground session",
  );
  assert(
    (await run(path.join(prefix, "bin/rw"), ["--version"])) === cliVersion,
    "Server update changed the CLI version",
  );
  assert(
    createHash("sha256").update(readFileSync(cliEntry)).digest("hex") ===
      cliHash,
    "Server update replaced the CLI binary",
  );
  const sourceUpdate = path.join(fixture, "source-update");
  for (const name of ["package", `${process.platform}-${process.arch}`]) {
    const dir = path.join(sourceUpdate, name);
    cpSync(path.join(source, name), dir, { recursive: true });
    const pkg = JSON.parse(
      readFileSync(path.join(dir, "package.json"), "utf8"),
    );
    pkg.version = "0.1.2";
    writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
    if (name !== "package") {
      const manifest = JSON.parse(
        readFileSync(path.join(dir, "manifest.json"), "utf8"),
      );
      manifest.version = "0.1.2";
      writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
    }
  }
  await cli("update", "--server-package", path.join(sourceUpdate, "package"));
  status = JSON.parse(await cli("status", "--json"));
  assert(
    status.healthy &&
      status.runningVersion === "0.1.2" &&
      status.installedVersion === "0.1.2",
    "Source artifact did not activate through the shared lifecycle",
  );
  await cli("update", "--version", "0.1.1");
  status = JSON.parse(await cli("status", "--json"));
  assert(
    status.healthy && status.runningVersion === "0.1.1",
    "NPM update after source activation failed",
  );
  assert(
    createHash("sha256").update(readFileSync(cliEntry)).digest("hex") ===
      cliHash,
    "Alternating source/NPM updates changed rw",
  );
  const rendered = JSON.parse(await cli("service", "install", "--dry-run"));
  for (const name of ["backend", "appServer"])
    assert(
      rendered[name].includes(home) &&
        !rendered[name].includes("Npm-fixture-private"),
      "Service definition wrong or contains credentials",
    );
  await cli("stop");
  status = JSON.parse(await cli("status", "--json"));
  assert(
    !status.backend.pid && !status.appServer.pid && status.mode === "stopped",
    "Stop left owned components running",
  );
  if (keepRunning) {
    foreground = spawn(path.join(prefix, "bin/rw"), ["server", "start"], {
      env,
      cwd: fixture,
      detached: true,
      stdio: ["ignore", log, log],
    });
    foreground.unref();
  }
  const result = {
    passed: true,
    fixture,
    address: url,
    keepRunning,
    target: `${process.platform}-${process.arch}`,
    distribution: "loopback npm registry fixture",
    verified: [
      "independent CLI and Server tarball installs outside repository",
      "native load",
      "idempotent init",
      "existing source App Server rejects Server without changing its runtime tree or health",
      "foreground health and bundled webpage",
      "App Server business status integration",
      "local management auth and lease",
      "foreground restart",
      "Server update 0.1.0 to fixture 0.1.1 preserving CLI and foreground session",
      "independent CLI/Server installation without rw collision",
      "source artifact activation followed by NPM activation using the same service",
      "service definition dry-run",
      "stop cleanup",
    ],
    notVerified: [
      "system service install and reboot",
      "real registry publication",
      "other target platforms",
      "web/desktop interaction",
      "live service-owned execution cancellation",
    ],
  };
  writeFileSync(
    path.join(fixture, "verification.json"),
    JSON.stringify(result, null, 2),
  );
  succeeded = true;
  console.log(JSON.stringify(result, null, 2));
} finally {
  if ((!keepRunning || !succeeded) && foreground?.exitCode === null) {
    await cli("stop").catch(() => {
      foreground.kill("SIGTERM");
    });
  }
  if (log !== undefined) closeSync(log);
  await new Promise((resolve) => registry.close(resolve));
  // Preserve logs and receipts, but do not preserve test passwords or npm caches.
  rmSync(path.join(fixture, "auth.json"), { force: true });
}
