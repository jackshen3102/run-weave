import { createBackup } from "./backup.mjs";
import { authenticatedReadback } from "./readback.mjs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  open,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const [action, ...args] = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i += 2) {
  if (!["--config", "--image", "--backup"].includes(args[i]) || !args[i + 1])
    throw new Error("Expected --config, --image or --backup");
  flags[args[i].slice(2)] = args[i + 1];
}
if (
  !["deploy", "backup", "restore"].includes(action) ||
  !path.isAbsolute(flags.config ?? "")
)
  throw new Error(
    "Expected deploy|backup|restore --config <absolute JSON path>",
  );
const config = JSON.parse(await readFile(flags.config, "utf8"));
const required = [
  "environment",
  "targetHost",
  "targetPath",
  "envFile",
  "project",
  "domain",
  "tls",
  "apiURL",
  "backupLocation",
  "rpoSeconds",
  "rtoSeconds",
  "pauseSeconds",
  "ownerCredentialsFile",
];
const absent = required.filter(
  (key) => config[key] === undefined || config[key] === "",
);
if (absent.length)
  throw new Error(`Missing configuration fields: ${absent.join(", ")}`);
if (
  !["development", "production"].includes(config.environment) ||
  ![os.hostname(), "localhost"].includes(config.targetHost)
)
  throw new Error("Run this command on the explicitly configured target host");
for (const key of ["targetPath", "envFile"])
  if (!path.isAbsolute(config[key])) throw new Error(`${key} must be absolute`);
for (const key of ["rpoSeconds", "rtoSeconds", "pauseSeconds"])
  if (!Number.isSafeInteger(config[key]) || config[key] <= 0)
    throw new Error(`${key} must be a positive integer`);
if (!/^[a-z0-9][a-z0-9-]+$/.test(config.project))
  throw new Error("Invalid project");
const apiURL = new URL(config.apiURL);
if (apiURL.username || apiURL.password || apiURL.search || apiURL.hash)
  throw new Error("apiURL cannot contain credentials or query");
if (
  config.environment === "production" &&
  (apiURL.protocol !== "https:" || config.tls !== "external-reverse-proxy")
)
  throw new Error("Production requires explicit HTTPS reverse proxy");
if (
  config.environment === "development" &&
  !["external-reverse-proxy", "local-loopback"].includes(config.tls)
)
  throw new Error("Invalid TLS mode");
if (
  config.tls === "local-loopback" &&
  !["127.0.0.1", "localhost", "[::1]"].includes(apiURL.hostname)
)
  throw new Error("Plain HTTP development must use loopback");
const remote = config.backupLocation.match(
  /^([a-zA-Z0-9_.-]+)@([a-zA-Z0-9.-]+):(\/[a-zA-Z0-9_./-]+)$/,
);
if (
  !remote ||
  [os.hostname(), "localhost", "127.0.0.1", config.targetHost].includes(
    remote[2],
  )
)
  throw new Error(
    "backupLocation requires an explicit separate host user@host:/absolute/path",
  );
if (!path.isAbsolute(config.ownerCredentialsFile))
  throw new Error("ownerCredentialsFile must be absolute");
const credentialStat = await stat(config.ownerCredentialsFile);
if ((credentialStat.mode & 0o077) !== 0)
  throw new Error("ownerCredentialsFile must be private");
const ownerCredentials = JSON.parse(
  await readFile(config.ownerCredentialsFile, "utf8"),
);
if (
  typeof ownerCredentials.username !== "string" ||
  typeof ownerCredentials.password !== "string"
)
  throw new Error("Owner credentials require username/password");
if (apiURL.hostname !== config.domain)
  throw new Error("domain must match apiURL hostname");
const env = {};
for (const line of (await readFile(config.envFile, "utf8")).split("\n")) {
  if (!line.trim() || line.startsWith("#")) continue;
  const match = line.match(/^([A-Z_]+)=(.*)$/);
  if (!match) throw new Error("Invalid deployment env format");
  env[match[1]] = match[2];
}
for (const key of [
  "SUIJI_DATA_DIR",
  "SUIJI_DB_PASSWORD_FILE",
  "SUIJI_API_PASSWORD_FILE",
])
  if (!path.isAbsolute(env[key] ?? ""))
    throw new Error(`Missing absolute ${key}`);
if (
  config.environment === "production" &&
  /^\/(?:tmp|private\/tmp|var\/tmp)(?:\/|$)/.test(env.SUIJI_DATA_DIR)
)
  throw new Error("Production requires persistent data directory");
for (const key of ["SUIJI_DB_PASSWORD_FILE", "SUIJI_API_PASSWORD_FILE"]) {
  const file = await stat(env[key]);
  if ((file.mode & 0o077) !== 0 || file.size < 20)
    throw new Error(`${key} requires protected nonempty credentials`);
}
const immutable = (image) =>
  /^sha256:[a-f0-9]{64}$/.test(image ?? "") ||
  /^[\w./:-]+@sha256:[a-f0-9]{64}$/.test(image ?? "");
const stateFile = path.join(config.targetPath, "release-state.json");
let state;
try {
  state = JSON.parse(await readFile(stateFile, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (action === "deploy" && !immutable(flags.image))
  throw new Error("An immutable --image digest is required");
if (action === "backup" && !state)
  throw new Error("No recorded deployment to back up");
env.SUIJI_IMAGE =
  action === "deploy" ? flags.image : (state?.image ?? env.SUIJI_IMAGE);
env.SUIJI_REVISION = env.SUIJI_REVISION || env.SUIJI_IMAGE;
const commandEnv = { ...process.env, ...env };
const composeArgs = [
  "compose",
  "--project-name",
  config.project,
  "--env-file",
  config.envFile,
  "-f",
  path.join(here, "compose.yaml"),
];
function run(program, argv, { file, input, inputFile, capture = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, argv, {
      env: commandEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    const stream = file
      ? createWriteStream(file, { mode: 0o600, flags: "wx" })
      : undefined;
    if (stream) child.stdout.pipe(stream);
    else
      child.stdout.on("data", (data) => {
        if (capture) output += data;
      });
    // Tool diagnostics can include SQL. Record only phase, command and exit status in the release log.
    child.stderr.resume();
    child.on("error", reject);
    if (inputFile)
      createReadStream(inputFile).on("error", reject).pipe(child.stdin);
    else child.stdin.end(input);
    child.stdin.on("error", reject);
    child.on("close", async (code) => {
      if (stream && !stream.writableFinished)
        await new Promise((r, j) => {
          stream.on("finish", r);
          stream.on("error", j);
        });
      if (code !== 0) reject(new Error(`${program} failed (${code})`));
      else resolve(output.trim());
    });
    stream?.on("error", (error) => {
      child.kill("SIGTERM");
      reject(error);
    });
  });
}
const compose = (argv, options) =>
  run("docker", [...composeArgs, ...argv], options);
const sql = (query) =>
  compose(
    [
      "exec",
      "-T",
      "db",
      "psql",
      "-U",
      "postgres",
      "-d",
      "suiji",
      "-tA",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { input: query },
  );
const sum = async (file) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};
const writeState = async (value) => {
  const tmp = stateFile + ".tmp";
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await (await import("node:fs/promises")).rename(tmp, stateFile);
};
async function healthy(image) {
  const id = await compose(["ps", "-q", "api"]);
  if (
    !id ||
    (await run("docker", ["inspect", "--format", "{{.Image}}", id])) !==
      (await run("docker", ["image", "inspect", "--format", "{{.Id}}", image]))
  )
    throw new Error("Running API image differs from target");
  const response = await fetch(new URL("/health", config.apiURL), {
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok || !(await response.json()).ok)
    throw new Error("Configured endpoint is not healthy");
}
const snapshot = createBackup({
  config,
  env,
  getState: () => state,
  compose,
  sql,
  sum,
  run,
  remote,
});
await mkdir(config.targetPath, { recursive: true, mode: 0o700 });
const lockPath = path.join(config.targetPath, "release.lock");
const lock = await open(lockPath, "wx", 0o600).catch(() => {
  throw new Error("Deployment lock exists; inspect its owner before recovery");
});
await lock.writeFile(
  JSON.stringify({
    pid: process.pid,
    action,
    startedAt: new Date().toISOString(),
  }),
);
let phase = "preflight";
try {
  await compose(["config", "--quiet"]);
  if (action === "backup") {
    phase = "backup";
    console.log(JSON.stringify({ backup: await snapshot() }));
  }
  if (action === "deploy") {
    if (state) {
      phase = "backup";
      commandEnv.SUIJI_IMAGE = state.image;
      await snapshot();
    }
    commandEnv.SUIJI_IMAGE = flags.image;
    phase = "artifact";
    await run("docker", ["image", "inspect", flags.image]).catch(() =>
      run("docker", ["pull", flags.image]),
    );
    await mkdir(path.join(env.SUIJI_DATA_DIR, "attachments"), {
      recursive: true,
      mode: 0o700,
    });
    // Explicitly owned service storage. Run as the image UID; never chown a parent directory.
    await compose([
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "--user",
      "0",
      "--entrypoint",
      "chown",
      "api",
      "1000:1000",
      "/data/attachments",
    ]);
    await compose(["up", "-d", "--wait", "db"]);
    phase = "migration";
    await compose(["run", "--rm", "-T", "admin", "migrate"]);
    if (Number(await sql("SELECT count(*) FROM owners")) === 0)
      await compose(["run", "--rm", "-T", "admin", "init"], {
        input: JSON.stringify(ownerCredentials),
      });
    phase = "replace";
    await compose(["up", "-d", "--wait", "--no-deps", "api"]);
    phase = "ready";
    await healthy(flags.image);
    await authenticatedReadback(config, ownerCredentials, sql);
    state = {
      image: flags.image,
      revision: env.SUIJI_REVISION,
      schemaVersion: Number(await sql("SELECT count(*) FROM suiji_migrations")),
      deployedAt: new Date().toISOString(),
    };
    await writeState(state);
    console.log(
      JSON.stringify({
        event: "deployed",
        ...state,
        ownerInitialized:
          Number(await sql("SELECT count(*) FROM owners")) === 1,
      }),
    );
  }
  if (action === "restore") {
    phase = "restore-preflight";
    if (
      config.environment !== "development" ||
      config.restoreIsolated !== true ||
      state
    )
      throw new Error(
        "Restore requires an explicitly isolated empty development target",
      );
    if (!path.isAbsolute(flags.backup ?? ""))
      throw new Error("Absolute --backup directory required");
    for (const name of ["postgres", "attachments"]) {
      const entries = await readdir(path.join(env.SUIJI_DATA_DIR, name)).catch(
        (error) => {
          if (error.code === "ENOENT") return [];
          throw error;
        },
      );
      if (entries.length) throw new Error("Restore target is not empty");
    }
    if (await compose(["ps", "-aq"]))
      throw new Error("Restore target already has containers");
    const manifest = JSON.parse(
      await readFile(path.join(flags.backup, "manifest.json"), "utf8"),
    );
    await readFile(path.join(flags.backup, "complete.json")); // An incomplete or off-host-unverified backup is not accepted.
    if (!immutable(manifest.image))
      throw new Error("Backup has no immutable image");
    for (const name of ["database.dump", "attachments.tar"])
      if (
        manifest.checksums[name] !== (await sum(path.join(flags.backup, name)))
      )
        throw new Error("Backup checksum mismatch");
    commandEnv.SUIJI_IMAGE = manifest.image;
    commandEnv.SUIJI_REVISION = manifest.appVersion;
    await run("docker", ["image", "inspect", manifest.image]).catch(() =>
      run("docker", ["pull", manifest.image]),
    );
    const entries = await run("tar", [
      "-tf",
      path.join(flags.backup, "attachments.tar"),
    ]);
    if (
      entries
        .split("\n")
        .some(
          (name) =>
            !/^\.\/(?:$|(?:objects|tmp)\/(?:[a-f0-9-]{36})?$)/.test(name),
        )
    )
      throw new Error("Unexpected attachment archive paths");
    const listing = await run("tar", [
      "-tvf",
      path.join(flags.backup, "attachments.tar"),
    ]);
    if (listing.split("\n").some((line) => !["-", "d"].includes(line[0])))
      throw new Error("Attachment archive contains links or special files");
    phase = "restore";
    const start = Date.now();
    await mkdir(path.join(env.SUIJI_DATA_DIR, "attachments"), {
      recursive: true,
    });
    await compose(["up", "-d", "--wait", "db"]);
    if (
      Number(
        await sql(
          "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'",
        ),
      ) !== 0
    )
      throw new Error("Restore database is not empty");
    await compose(
      [
        "exec",
        "-T",
        "db",
        "pg_restore",
        "-U",
        "postgres",
        "-d",
        "suiji",
        "--no-owner",
        "--no-acl",
        "--exit-on-error",
        "--single-transaction",
      ],
      { inputFile: path.join(flags.backup, "database.dump") },
    );
    await sql(
      "GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO suiji_api",
    );
    await compose(
      [
        "run",
        "--rm",
        "--no-deps",
        "-T",
        "--user",
        "0",
        "--entrypoint",
        "tar",
        "api",
        "-C",
        "/data/attachments",
        "-xf",
        "-",
      ],
      { inputFile: path.join(flags.backup, "attachments.tar") },
    );
    await compose([
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "--user",
      "0",
      "--entrypoint",
      "chown",
      "api",
      "-R",
      "1000:1000",
      "/data/attachments",
    ]);
    for (const object of manifest.objects) {
      if (
        !/^[a-f0-9-]{36}$/.test(object.key) ||
        (await sum(
          path.join(env.SUIJI_DATA_DIR, "attachments/objects", object.key),
        )) !== object.sha256
      )
        throw new Error("Restored attachment checksum mismatch");
    }
    const counts = JSON.parse(
      await sql(
        "SELECT json_build_object('records',(SELECT count(*) FROM records),'revisions',(SELECT count(*) FROM record_revisions),'mutations',(SELECT count(*) FROM mutation_requests),'attachments',(SELECT count(*) FROM attachments))",
      ),
    );
    if (JSON.stringify(counts) !== JSON.stringify(manifest.counts))
      throw new Error("Restored database counts mismatch");
    const identity = JSON.parse(
      await sql(
        "SELECT json_build_object('serverId',server_id,'ownerId',id) FROM server_identity CROSS JOIN owners",
      ),
    );
    if (JSON.stringify(identity) !== JSON.stringify(manifest.identity))
      throw new Error("Restored identity mismatch");
    await compose(["up", "-d", "--wait", "--no-deps", "api"]);
    await healthy(manifest.image);
    const readback = await authenticatedReadback(config, ownerCredentials, sql);
    await writeState({
      image: manifest.image,
      revision: manifest.appVersion,
      schemaVersion: manifest.schemaVersion,
      restoredAt: new Date().toISOString(),
    });
    const seconds = (Date.now() - start) / 1000;
    console.log(
      JSON.stringify({
        event: "restored",
        seconds,
        withinRTO: seconds <= config.rtoSeconds,
        readback,
      }),
    );
  }
} catch (error) {
  const failure = { event: "release_failed", phase, message: error.message };
  await writeFile(
    path.join(config.targetPath, `failure-${Date.now()}.json`),
    JSON.stringify(failure),
    { mode: 0o600 },
  );
  console.error(JSON.stringify(failure));
  process.exitCode = 1;
  // Never down schema or switch to an unproven-compatible old image automatically.
} finally {
  await lock.close();
  await rm(lockPath);
}
