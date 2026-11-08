import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { assertPrivateDirectory, canonicalPath, processStartIdentity, readPrivateFile } from "@runweave/config-node";
import type { EnvironmentContext } from "@runweave/shared/configuration";
import { PTY_HOST_PROTOCOL_VERSION, type PtyHostDescriptor } from "@runweave/shared/terminal/pty-host";

export function hostPaths(scope: EnvironmentContext) {
  const root = path.join(scope.configRoot, "runtime/pty-host");
  const key = createHash("sha256").update(canonicalPath(root).toLowerCase()).digest("hex").slice(0, 24);
  return {
    root,
    descriptor: path.join(root, "host.json"),
    token: path.join(root, "token"),
    launch: path.join(root, "launch.json"),
    endpoint: process.platform === "win32" ? `\\\\.\\pipe\\runweave-pty-${key}` : path.join(os.tmpdir(), `rw-pty-${key}.sock`),
  };
}

export function prepareHostDirectory(scope: EnvironmentContext): ReturnType<typeof hostPaths> {
  const paths = hostPaths(scope);
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(scope.configRoot);
  assertPrivateDirectory(path.dirname(paths.root));
  assertPrivateDirectory(paths.root);
  if (!existsSync(paths.token)) {
    try { writeFileSync(paths.token, randomUUID() + randomUUID(), { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  readPrivateFile(paths.token, 256);
  return paths;
}

export function readHost(scope: EnvironmentContext): { descriptor: PtyHostDescriptor; token: string } {
  const paths = hostPaths(scope);
  assertPrivateDirectory(paths.root);
  const descriptor = JSON.parse(readPrivateFile(paths.descriptor, 16_384)) as PtyHostDescriptor;
  if (descriptor.protocolVersion !== PTY_HOST_PROTOCOL_VERSION) throw new Error("HOST_PROTOCOL_INCOMPATIBLE");
  if (descriptor.scope?.kind !== scope.kind || descriptor.scope.instanceId !== scope.instanceId ||
      canonicalPath(descriptor.scope.configRoot) !== canonicalPath(scope.configRoot) || descriptor.endpoint !== paths.endpoint ||
      !/^[a-f0-9-]{36}$/.test(descriptor.hostInstanceId) || !Number.isSafeInteger(descriptor.pid) || descriptor.pid <= 1 ||
      typeof descriptor.startedAt !== "string" || !descriptor.startedAt || !path.isAbsolute(descriptor.release))
    throw new Error("HOST_IDENTITY_MISMATCH");
  const url = new URL(descriptor.gatewayUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/")
    throw new Error("HOST_IDENTITY_MISMATCH");
  if (processStartIdentity(descriptor.pid) !== descriptor.startedAt) throw new Error("HOST_UNAVAILABLE");
  const token = readPrivateFile(paths.token, 256).trim();
  if (token.length < 32) throw new Error("HOST_AUTH_FAILED");
  return { descriptor, token };
}

export function writeHostJson(file: string, data: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(data) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(temporary, file);
}

/** Read only the last-known identity for stale-record diagnostics; not authorization. */
export function recordedHostPid(scope: EnvironmentContext): number | null {
  try {
    const value = JSON.parse(readFileSync(hostPaths(scope).descriptor, "utf8"));
    return Number.isSafeInteger(value.pid) && value.pid > 1 ? value.pid : null;
  } catch { return null; }
}
