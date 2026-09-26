import "./native-lock";
import { constants, existsSync, mkdirSync, openSync, closeSync, writeFileSync, renameSync, fsyncSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { tryLock } from "fs-native-extensions";
import type { EnvironmentContext } from "@runweave/shared/configuration";
import { ConfigurationError } from "./errors";
import { canonicalPath } from "./context";
import { assertPrivateDirectory, assertPrivateDescriptor, readPrivateFile } from "./private-file";

function ownerDirectory(context: EnvironmentContext): string {
  const directory = context.kind === "stable"
    ? path.join(os.userInfo().homedir, ".runweave", "runtime")
    : path.join(context.configRoot, "runtime");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(path.dirname(directory));
  assertPrivateDirectory(directory);
  return directory;
}

/** Stable selection is registered on the first successful write, not just start. */
export function registerStableConfigurationRoot(context: EnvironmentContext): void {
  if (context.kind !== "stable") return;
  const directory = ownerDirectory(context);
  const registry = path.join(directory, "stable-root.json");
  const registryFd = openSync(path.join(directory, "stable-root.lock"), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    assertPrivateDescriptor(registryFd);
    if (!tryLock(registryFd)) throw new ConfigurationError("CONFIG_ROOT_REGISTRATION_BUSY");
    if (existsSync(registry)) {
      let stored: unknown;
      try { stored = JSON.parse(readPrivateFile(registry)); } catch { throw new ConfigurationError("CONFIG_ROOT_REGISTRY_INVALID"); }
      if (!stored || typeof stored !== "object" || !("root" in stored) || stored.root !== canonicalPath(context.configRoot)) throw new ConfigurationError("CONFIG_STABLE_ROOT_CONFLICT");
    } else {
      const temporary = `${registry}.${randomUUID()}.tmp`;
      const file = openSync(temporary, "wx", 0o600);
      try { writeFileSync(file, JSON.stringify({ root: canonicalPath(context.configRoot) })); fsyncSync(file); } finally { closeSync(file); }
      renameSync(temporary, registry);
      const parent = openSync(directory, "r");
      try { fsyncSync(parent); } finally { closeSync(parent); }
    }
  } finally { closeSync(registryFd); }
}

export function acquireConfigurationOwner(context: EnvironmentContext, role: "backend" | "app-server" | "desktop" | "snapshot-host" | "push-gateway" | "suiji-server"): { release(): void } {
  const directory = ownerDirectory(context);
  const fd = openSync(path.join(directory, `${role}.owner.lock`), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  let closed = false;
  const release = () => { if (!closed) { closed = true; closeSync(fd); } };
  try {
    assertPrivateDescriptor(fd);
    if (!tryLock(fd)) throw new ConfigurationError("CONFIG_INSTANCE_ALREADY_RUNNING", [role]);
    registerStableConfigurationRoot(context);
    return { release };
  } catch (error) { release(); throw error; }
}
