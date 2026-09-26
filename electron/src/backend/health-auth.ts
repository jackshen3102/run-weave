import { settingText, configuration, configurationPath } from "@runweave/config-node";
import { isIP } from "node:net";
import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { BackendProfileLockOwner } from "@runweave/shared/browser-profile-node";

interface BackendHealthAuth {
  ownerDevSessionId: string | null;
  token: string | null;
  scope: "all" | "forwarded";
}

function readBackendHealthAuth(profileDir: string): BackendHealthAuth {
  const runtime = configuration();
  if (path.resolve(profileDir) !== configurationPath("storage.browserProfileDirectory", "backend")) throw new Error("Backend health profile identity drifted");
  runtime.requireDomain("backend.tunnelAuth");
  return {
    ownerDevSessionId: runtime.context.kind === "dev" ? runtime.context.instanceId : null,
    token: settingText("backend.tunnelAuth.token") ?? null,
    scope: settingText("backend.tunnelAuth.scope") === "all" ? "all" : "forwarded",
  };
}

export function restoreOwnedBackendHealthEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...env };
  delete result.RUNWEAVE_TUNNEL_TOKEN;
  delete result.RUNWEAVE_TUNNEL_AUTH_SCOPE;
  return result;
}

export function localBackendAuthHeaders(
  url: string,
  profileDir: string,
  ownedEnv?: NodeJS.ProcessEnv,
  expectedPid?: number,
): Record<string, string> {
  const target = new URL(url);
  if (
    target.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(target.hostname) ||
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    !["/health", "/api/auth/login", "/api/auth/refresh"].includes(
      target.pathname,
    )
  ) {
    throw new Error(
      "Backend authentication endpoint must be exact loopback HTTP",
    );
  }
  const config = readBackendHealthAuth(profileDir);
  const token = config.token;
  if (ownedEnv?.RUNWEAVE_DEV_SESSION_ID && ownedEnv.RUNWEAVE_DEV_SESSION_ID !== config.ownerDevSessionId) throw new Error("Backend environment identity drifted");
  if (!token) return {};
  const recorded = readHealthProfileLock(profileDir);
  const lock = recorded.value;
  const owner = config.ownerDevSessionId;
  const hosts =
    target.hostname === "127.0.0.1" ? ["127.0.0.1", "0.0.0.0"] : ["::1", "::"];
  if (
    !hosts.includes(lock.host ?? "") ||
    !Number.isInteger(lock.pid) ||
    lock.pid <= 0 ||
    lock.port !== Number(target.port) ||
    (expectedPid !== undefined && lock.pid !== expectedPid) ||
    (lock.devSessionId ?? null) !== owner
  ) {
    throw new Error("Backend health profile identity drifted");
  }
  assertHealthListenerGeneration(lock, target);
  const current = readHealthProfileLock(profileDir);
  if (
    current.identity !== recorded.identity ||
    current.text !== recorded.text
  ) {
    throw new Error("Backend health profile lock changed");
  }
  return { Authorization: `Bearer ${token}` };
}

function readHealthProfileLock(profileDir: string): {
  value: BackendProfileLockOwner;
  text: string;
  identity: string;
} {
  let fd: number | undefined;
  try {
    fd = openSync(
      path.join(profileDir, "backend.lock.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.() ||
      stat.size > 65_536
    ) {
      throw new Error("invalid Backend health profile lock");
    }
    const bytes = Buffer.alloc(65_537);
    const bytesRead = readSync(fd, bytes, 0, bytes.length, 0);
    if (bytesRead > 65_536)
      throw new Error("oversized Backend health profile lock");
    const text = bytes.subarray(0, bytesRead).toString("utf8");
    return {
      value: JSON.parse(text) as BackendProfileLockOwner,
      text,
      identity: `${stat.dev}:${stat.ino}`,
    };
  } catch {
    throw new Error("Backend health profile lock unavailable");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function assertHealthListenerGeneration(
  lock: BackendProfileLockOwner,
  target: URL,
): void {
  const options = {
    encoding: "utf8" as const,
    timeout: 1_000,
    maxBuffer: 65_536,
    env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" },
    stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
  };
  const signature = (): string =>
    execFileSync(
      "/bin/ps",
      ["-p", String(lock.pid), "-o", "lstart=", "-o", "command="],
      options,
    ).trim();
  try {
    if (!lock.processSignature || signature() !== lock.processSignature) {
      throw new Error("generation mismatch");
    }
    const stdout = execFileSync(
      process.platform === "darwin" ? "/usr/sbin/lsof" : "/usr/bin/lsof",
      ["-nP", `-iTCP:${target.port}`, "-sTCP:LISTEN", "-F0pftn"],
      options,
    );
    const listeners = healthListenerPidsForEndpoint(stdout, target);
    if (
      !listeners.length ||
      !listeners.every((pid) => pid === lock.pid) ||
      signature() !== lock.processSignature
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
function healthListenerPidsForEndpoint(stdout: string, target: URL): number[] {
  if (!stdout.endsWith("\0\n"))
    throw new Error("incomplete listener inventory");
  let pid: number | null = null;
  let hasFile = false;
  const listeners: number[] = [];
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
    const values = new Map<string, string>();
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

function healthListenerMatchesEndpoint(
  name: string,
  family: "IPv4" | "IPv6",
  target: URL,
): boolean {
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
