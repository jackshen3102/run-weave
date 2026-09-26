import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EnvironmentContext } from "@runweave/shared/configuration";
import { ConfigurationError } from "./errors";
import { assertPrivateDirectory, readPrivateFile } from "./private-file";

const invocationArguments = new AsyncLocalStorage<string[]>();
export function withConfigurationArguments<T>(args: string[], run: () => T): T {
  return invocationArguments.run(args, run);
}

export function configurationOption(name: string, args = invocationArguments.getStore() ?? process.argv.slice(2)): string | undefined {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const item = args[i]!;
    if (item.startsWith(`--${name}=`)) values.push(item.slice(name.length + 3));
    else if (item === `--${name}`) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new ConfigurationError("CONFIG_ARGUMENT_REQUIRED", [name]);
      values.push(value);
    }
  }
  if (values.some((value) => !value || value !== values[0])) throw new ConfigurationError("CONFIG_ARGUMENT_CONFLICT", [name]);
  return values[0];
}

export function canonicalPath(value: string): string {
  const absolute = path.resolve(value);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = path.dirname(absolute);
  return parent === absolute ? absolute : path.join(canonicalPath(parent), path.basename(absolute));
}

export function resolveConfigurationContext(options: {
  args?: string[];
  home?: string;
  requireExplicit?: boolean;
} = {}): EnvironmentContext {
  const args = options.args ?? invocationArguments.getStore() ?? process.argv.slice(2);
  const id = configurationOption("instance", args);
  const requestedRoot = configurationOption("config-dir", args);
  if (options.requireExplicit && !id) throw new ConfigurationError("CONFIG_INSTANCE_REQUIRED");
  if (id && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw new ConfigurationError("CONFIG_INSTANCE_INVALID");
  // This is a rejection guard, never a source of configuration or authorization.
  const devMarker = process.env.RUNWEAVE_DEV_SESSION_ID?.trim();
  if (devMarker && (!id || id === "stable" || id !== devMarker)) throw new ConfigurationError("CONFIG_INSTANCE_CONFLICT");
  const instanceId = id ?? "stable";
  const kind = instanceId === "stable" ? "stable" : "dev";
  const globalRoot = path.join(options.home ?? os.userInfo().homedir, ".runweave");
  let stableRoot = globalRoot;
  const registry = path.join(globalRoot, "runtime", "stable-root.json");
  if (kind === "stable" && existsSync(registry)) {
    try {
      assertPrivateDirectory(globalRoot);
      assertPrivateDirectory(path.dirname(registry));
      const stored: unknown = JSON.parse(readPrivateFile(registry));
      if (!stored || typeof stored !== "object" || !("root" in stored) || typeof stored.root !== "string" || !path.isAbsolute(stored.root)) throw new Error();
      stableRoot = stored.root;
      if (requestedRoot && canonicalPath(requestedRoot) !== canonicalPath(stableRoot)) throw new ConfigurationError("CONFIG_STABLE_ROOT_CONFLICT");
    } catch (error) {
      if (error instanceof ConfigurationError) throw error;
      throw new ConfigurationError("CONFIG_ROOT_REGISTRY_INVALID");
    }
  }
  const defaultRoot = kind === "stable" ? stableRoot : path.join(globalRoot, "dev-sessions", instanceId);
  if (requestedRoot && !path.isAbsolute(requestedRoot)) throw new ConfigurationError("CONFIG_ROOT_MUST_BE_ABSOLUTE");
  const configRoot = canonicalPath(requestedRoot ?? defaultRoot);
  if (kind === "dev" && (configRoot !== canonicalPath(defaultRoot) || configRoot !== path.join(canonicalPath(globalRoot), "dev-sessions", instanceId))) throw new ConfigurationError("CONFIG_INSTANCE_ROOT_MISMATCH");
  return { kind, instanceId, configRoot };
}

export function configurationArguments(context: EnvironmentContext): string[] {
  return ["--instance", context.instanceId, "--config-dir", context.configRoot];
}

export function assertOwnedPath(context: EnvironmentContext, value: string): void {
  if (context.kind === "stable") return;
  const root = canonicalPath(context.configRoot);
  const target = canonicalPath(value);
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ConfigurationError("CONFIG_PATH_OUTSIDE_INSTANCE");
  }
}
