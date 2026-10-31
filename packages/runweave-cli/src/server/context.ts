import { configurationOption } from "@runweave/config-node";
import {
  activateServer,
  findInstallation,
  materializeServer,
  serverPaths,
} from "./installation.js";
import { ConfigurationStore } from "@runweave/config-node";
import { readConfigurationPath } from "@runweave/shared/configuration";
import type { ServerReleaseManifest } from "@runweave/shared/server-management";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { tryLock } from "fs-native-extensions";

export function serverContext(args: string[]) {
  const base = serverPaths(args);
  const installation = findInstallation(
    base.home,
    configurationOption("server-package", args),
  );
  const current = path.join(base.home, "current");
  let release: string;
  if (!existsSync(current)) {
    const initial = materializeServer(installation.packageRoot, base.home);
    verifyRelease(initial.release);
    activateServer(base.home, initial.release, installation);
    release = initial.release;
  } else {
    release = realpathSync(current);
    if (!release.startsWith(path.join(base.home, "releases") + path.sep))
      throw new Error("Invalid active Server release path");
  }
  const manifest = readJson<ServerReleaseManifest>(
    path.join(release, "server-manifest.json"),
  );
  if (manifest.managementApiVersion !== 1)
    throw new Error(
      "SERVER_API_INCOMPATIBLE: this Server runtime is not supported by the installed CLI",
    );
  return { ...base, installation, release, manifest };
}
export type ServerContext = ReturnType<typeof serverContext>;
export type Component = "backend" | "app-server";
export interface ProcessIdentity {
  pid: number;
  startedAt: string;
  version: string;
  release: string;
}

export function controlSocket(ctx: ServerContext): string {
  // sockaddr_un has a small path limit (104 bytes on macOS), regardless of config path length.
  const directory = path.join("/tmp", `runweave-server-${process.getuid?.()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.mode & 0o077 ||
    stat.uid !== process.getuid?.()
  )
    throw new Error(
      "Control socket directory must be private and owned by the current user",
    );
  return path.join(
    directory,
    createHash("sha256").update(ctx.home).digest("hex").slice(0, 24) + ".sock",
  );
}

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}
export function writeJson(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
  renameSync(temporary, file);
}
export function processStart(pid: number): string | null {
  try {
    return (
      execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}
export function identity(
  ctx: ServerContext,
  name: Component | "foreground",
): ProcessIdentity | null {
  const file = path.join(ctx.home, `${name}.json`);
  if (!existsSync(file)) return null;
  const record = readJson<ProcessIdentity>(file);
  return Number.isSafeInteger(record.pid) &&
    record.pid > 1 &&
    processStart(record.pid) === record.startedAt
    ? record
    : null;
}
export async function withManagementLock<T>(
  ctx: ServerContext,
  action: () => Promise<T>,
): Promise<T> {
  const fd = openSync(path.join(ctx.home, "manage.lock"), "a+", 0o600);
  try {
    if (!tryLock(fd))
      throw new Error("SERVER_BUSY: another management operation is running");
    return await action();
  } finally {
    closeSync(fd);
  }
}
export function settings(ctx: ServerContext) {
  const value = new ConfigurationStore(ctx.context).read().value;
  const field = (name: string) => readConfigurationPath(value, name);
  const port = Number(field("backend.server.port") ?? 5001);
  const host = String(field("backend.server.host") ?? "127.0.0.1");
  return {
    value,
    port,
    host,
    localUrl: `http://127.0.0.1:${port}`,
    url: `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
    appState: String(field("appServer.stateDirectory")),
    profile: String(field("storage.browserProfileDirectory")),
  };
}
export async function requestJson(
  url: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok)
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}
export const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
export async function waitHealthy(
  ctx: ServerContext,
  name: Component,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if (name === "backend")
        await requestJson(settings(ctx).localUrl + "/health");
      else {
        const lock = readJson<{ port: number; baseUrl?: string }>(
          path.join(settings(ctx).appState, "app-server.lock.json"),
        );
        await requestJson(
          (lock.baseUrl ?? `http://127.0.0.1:${lock.port}`) + "/healthz",
        );
      }
      if (identity(ctx, name)?.release === ctx.release) return;
    } catch {
      /* A component can be between lock creation and listen. */
    }
    await delay(150);
  }
  throw new Error(`${name} did not become healthy; inspect rw server logs`);
}
export async function stopOwned(
  ctx: ServerContext,
  name: Component,
): Promise<void> {
  const owner = identity(ctx, name);
  if (!owner) return;
  process.kill(owner.pid, "SIGTERM");
  const deadline = Date.now() + 60_000;
  while (processStart(owner.pid) === owner.startedAt) {
    if (Date.now() > deadline)
      throw new Error(
        `${name} did not stop; refusing to replace a live runtime`,
      );
    await delay(100);
  }
}
export async function runChecked(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "ignore", "pipe"],
    });
    // npm errors can contain registry credentials; only report the exit status.
    child.stderr.resume();
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} failed (exit ${code})`)),
    );
  });
}
export function verifyRelease(root: string): ServerReleaseManifest {
  const manifest = readJson<ServerReleaseManifest>(
    path.join(root, "server-manifest.json"),
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.managementApiVersion !== 1 ||
    !/^\d+\.\d+\.\d+$/.test(manifest.version) ||
    manifest.platform !== process.platform ||
    manifest.arch !== process.arch ||
    manifest.nodeModuleAbi !== process.versions.modules ||
    !manifest.dataCompatibility
  )
    throw new Error(
      "Unsupported release platform, ABI or compatibility metadata",
    );
  for (const file of manifest.files) {
    if (path.isAbsolute(file.path) || file.path.split("/").includes(".."))
      throw new Error("Unsafe release entry");
    const bytes = readFileSync(path.join(root, file.path));
    if (
      bytes.length !== file.size ||
      createHash("sha256").update(bytes).digest("hex") !== file.sha256
    )
      throw new Error(`Release checksum mismatch: ${file.path}`);
  }
  return manifest;
}
