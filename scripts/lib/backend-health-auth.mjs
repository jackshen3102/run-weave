import { configurationLibrary as configuration } from "./configuration.mjs";
import { isIP } from "node:net";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const FILE_NAME = "backend-health-binding.json";

// This private, mutable profile file is never part of a manifest or status DTO.
export async function persistBackendHealthAuth(profileDir, sessionId, env) {
  if (!(sessionId === null || (typeof sessionId === "string" && sessionId))) {
    throw new Error("invalid Backend health configuration owner");
  }
  void env;
  const context = configuration.resolveConfigurationContext({ args: ["--instance", sessionId ?? "stable"] });
  const snapshot = new configuration.ConfigurationStore(context).read();
  const ownedProfile = snapshot.value.storage?.browserProfileDirectory ?? path.join(context.configRoot, "data", "backend");
  if (configuration.canonicalPath(profileDir) !== configuration.canonicalPath(ownedProfile)) throw new Error("Backend health binding profile mismatch");
  const serialized = JSON.stringify({ ownerDevSessionId: sessionId, configRoot: context.configRoot });
  if (Buffer.byteLength(serialized, "utf8") > 16_384) {
    throw new Error("oversized private Backend health configuration");
  }
  await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
  const directory = await fs.lstat(profileDir);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error("invalid Backend health profile directory");
  }
  const temporary = path.join(profileDir, `.${FILE_NAME}-${randomUUID()}`);
  try {
    await fs.writeFile(temporary, serialized, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, path.join(profileDir, FILE_NAME));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function readBackendHealthAuth(profileDir) {
  let handle;
  try {
    const directory = await fs.lstat(profileDir);
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new Error("invalid Backend health profile directory");
    handle = await fs.open(
      path.join(profileDir, FILE_NAME),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size > 16_384 ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.()
    ) {
      throw new Error("invalid private Backend health configuration");
    }
    const bytes = Buffer.alloc(16_385);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 16_384)
      throw new Error("oversized private Backend health configuration");
    const config = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    if (!(config.ownerDevSessionId === null || typeof config.ownerDevSessionId === "string") || typeof config.configRoot !== "string") throw new Error("invalid Backend health binding");
    const context = configuration.resolveConfigurationContext({ args: ["--instance", config.ownerDevSessionId ?? "stable", "--config-dir", config.configRoot] });
    const snapshot = new configuration.ConfigurationStore(context).read();
    const ownedProfile = snapshot.value.storage?.browserProfileDirectory ?? path.join(context.configRoot, "data", "backend");
    if (configuration.canonicalPath(profileDir) !== configuration.canonicalPath(ownedProfile) || snapshot.issues["backend.tunnelAuth"]?.length) throw new Error("Backend health binding mismatch");
    const token = snapshot.value.backend?.tunnelAuth?.token ?? null;
    if (token !== null && typeof token !== "string") throw new Error("invalid Backend health credential");
    return { ownerDevSessionId: config.ownerDevSessionId, token, scope: snapshot.value.backend?.tunnelAuth?.scope ?? "forwarded" };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    // JSON parse errors can contain credential bytes. Never expose the cause.
    throw new Error("invalid private Backend health configuration");
  } finally {
    await handle?.close();
  }
}

export async function backendHealthHeaders(url, profileDir) {
  const target = new URL(url);
  if (
    target.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(target.hostname) ||
    target.username ||
    target.password ||
    target.pathname !== "/health" ||
    target.search ||
    target.hash
  ) {
    throw new Error(
      "Backend health endpoint must be exact loopback HTTP /health",
    );
  }
  const config = await readBackendHealthAuth(profileDir);
  if (!config?.token) return {};
  const recorded = await readHealthProfileLock(profileDir);
  const lock = recorded.value;
  const hosts =
    target.hostname === "127.0.0.1" ? ["127.0.0.1", "0.0.0.0"] : ["::1", "::"];
  if (
    !hosts.includes(lock.host) ||
    !Number.isInteger(lock.pid) ||
    lock.pid <= 0 ||
    lock.port !== Number(target.port) ||
    (lock.devSessionId ?? null) !== config.ownerDevSessionId
  ) {
    throw new Error("Backend health profile identity drifted");
  }
  await assertHealthListenerGeneration(lock, target);
  const current = await readHealthProfileLock(profileDir);
  if (
    current.identity !== recorded.identity ||
    current.text !== recorded.text
  ) {
    throw new Error("Backend health profile lock changed");
  }
  return { Authorization: `Bearer ${config.token}` };
}

async function readHealthProfileLock(profileDir) {
  let handle;
  try {
    handle = await fs.open(
      path.join(profileDir, "backend.lock.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.() ||
      stat.size > 65_536
    ) {
      throw new Error("invalid Backend health profile lock");
    }
    const bytes = Buffer.alloc(65_537);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 65_536)
      throw new Error("oversized Backend health profile lock");
    const text = bytes.subarray(0, bytesRead).toString("utf8");
    return {
      value: JSON.parse(text),
      text,
      identity: `${stat.dev}:${stat.ino}`,
    };
  } catch {
    throw new Error("Backend health profile lock unavailable");
  } finally {
    await handle?.close();
  }
}

async function assertHealthListenerGeneration(lock, target) {
  const options = {
    encoding: "utf8",
    timeout: 1_000,
    maxBuffer: 65_536,
    env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" },
  };
  const signature = async () =>
    (
      await execFileAsync(
        "/bin/ps",
        ["-p", String(lock.pid), "-o", "lstart=", "-o", "command="],
        options,
      )
    ).stdout.trim();
  try {
    if (
      !lock.processSignature ||
      (await signature()) !== lock.processSignature
    ) {
      throw new Error("generation mismatch");
    }
    const { stdout } = await execFileAsync(
      process.platform === "darwin" ? "/usr/sbin/lsof" : "/usr/bin/lsof",
      ["-nP", `-iTCP:${target.port}`, "-sTCP:LISTEN", "-F0pftn"],
      options,
    );
    const listeners = healthListenerPidsForEndpoint(stdout, target);
    if (
      !listeners.length ||
      !listeners.every((pid) => pid === lock.pid) ||
      (await signature()) !== lock.processSignature
    ) {
      throw new Error("listener or generation mismatch");
    }
  } catch {
    throw new Error("Backend health listener generation cannot be proven");
  }
}

// Keep this OS-adapter parser aligned with the other Backend health adapter.
// -F0pftn emits NUL fields and newline-separated process/file records. Unknown
// records cannot be discarded: they may conceal a socket serving the target.
function healthListenerPidsForEndpoint(stdout, target) {
  if (!stdout.endsWith("\0\n"))
    throw new Error("incomplete listener inventory");
  let pid = null;
  let hasFile = false;
  const listeners = [];
  for (const record of stdout.slice(0, -1).split("\n")) {
    const fields = record.split("\0");
    if (fields.pop() !== "") throw new Error("invalid listener record framing");
    const first = fields[0] ?? "";
    if (/^p[1-9][0-9]*$/.test(first)) {
      if (fields.length !== 1 || (pid !== null && !hasFile))
        throw new Error("incomplete listener process");
      pid = Number(first.slice(1));
      if (!Number.isSafeInteger(pid)) throw new Error("invalid listener pid");
      hasFile = false;
      continue;
    }
    if (pid === null || !/^f[0-9]+$/.test(first) || fields.length !== 3)
      throw new Error("invalid listener file record");
    const values = new Map();
    for (const field of fields) {
      const key = field.slice(0, 1);
      if (!["f", "t", "n"].includes(key) || values.has(key))
        throw new Error("unknown or duplicate listener field");
      values.set(key, field.slice(1));
    }
    const family = values.get("t");
    const name = values.get("n");
    if ((family !== "IPv4" && family !== "IPv6") || !name)
      throw new Error("unknown listener address family");
    if (healthListenerMatchesEndpoint(name, family, target))
      listeners.push(pid);
    hasFile = true;
  }
  if (!hasFile) throw new Error("empty listener inventory");
  return listeners;
}

function healthListenerMatchesEndpoint(name, family, target) {
  const endpoint = /^(\*|[0-9.]+|\[[^\]\r\n]+\]):([0-9]+)$/.exec(name);
  if (!endpoint || Number(endpoint[2]) !== Number(target.port))
    throw new Error("invalid listener endpoint");
  const ipv4Target = target.hostname === "127.0.0.1";
  let address = endpoint[1] ?? "";
  // lsof does not prove IPV6_V6ONLY: an IPv6 wildcard can serve either family.
  if (address === "*") return family === "IPv6" || ipv4Target;
  if (address.startsWith("[")) address = address.slice(1, -1);
  const [numeric = "", zone] = address.split("%");
  if (
    address.split("%").length > 2 ||
    (zone !== undefined && !/^[A-Za-z0-9_.-]+$/.test(zone))
  )
    throw new Error("invalid listener scope");
  const version = isIP(numeric);
  if (version === 4 && zone === undefined && !endpoint[1]?.startsWith("[")) {
    // macOS also emits dotted IPv4 names for IPv4-mapped IPv6 sockets.
    return ipv4Target && (numeric === "0.0.0.0" || numeric === "127.0.0.1");
  }
  if (version !== 6 || family !== "IPv6")
    throw new Error("invalid listener address");
  const normalized = new URL(`http://[${numeric}]/`).hostname.slice(1, -1);
  if (normalized === "::") return true;
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(normalized);
  if (mapped) {
    const high = Number.parseInt(mapped[1] ?? "", 16);
    const low = Number.parseInt(mapped[2] ?? "", 16);
    const ipv4 = `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
    return ipv4Target && (ipv4 === "0.0.0.0" || ipv4 === "127.0.0.1");
  }
  return !ipv4Target && normalized === "::1";
}
