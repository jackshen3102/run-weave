import { resolveConfigurationContext } from "@runweave/config-node";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ServerReleaseManifest } from "@runweave/shared/server-management";

export interface ServerInstallation {
  schemaVersion: 1;
  packageRoot: string;
  /** npm global prefix, or null for an explicitly selected source artifact. */
  npmPrefix: string | null;
}

export class ServerNotInstalledError extends Error {
  constructor() {
    super(
      "SERVER_NOT_INSTALLED: install @runweave/server, or select a source artifact with --server-package <absolute package directory>",
    );
  }
}

export function serverPaths(args: string[]) {
  const context = resolveConfigurationContext({ args });
  if (context.instanceId !== "stable")
    throw new Error("The standalone server supports one stable instance");
  const home = path.join(context.configRoot, "server");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const stat = lstatSync(home);
  if (
    !stat.isDirectory() ||
    stat.mode & 0o077 ||
    stat.uid !== process.getuid?.()
  )
    throw new Error(
      "Server directory must be private and owned by the current user",
    );
  return {
    context,
    home,
    configArgs: ["--instance", "stable", "--config-dir", context.configRoot],
  };
}

export function describeInstallation(directory: string): ServerInstallation {
  if (!path.isAbsolute(directory))
    throw new Error("--server-package must be an absolute directory");
  const packageRoot = realpathSync(directory);
  const pkg = JSON.parse(
    readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  ) as { name: string; version: string };
  if (pkg.name !== "@runweave/server" || !/^\d+\.\d+\.\d+$/.test(pkg.version))
    throw new Error("Expected an @runweave/server release package");
  const prefix = path.resolve(packageRoot, "../../../..");
  return {
    schemaVersion: 1,
    packageRoot,
    npmPrefix:
      path.join(prefix, "lib/node_modules/@runweave/server") === packageRoot
        ? prefix
        : null,
  };
}

export function findInstallation(
  home: string,
  explicit?: string,
): ServerInstallation {
  const file = path.join(home, "installation.json");
  if (existsSync(file)) {
    const record = JSON.parse(readFileSync(file, "utf8")) as ServerInstallation;
    if (record.schemaVersion !== 1 || !path.isAbsolute(record.packageRoot))
      throw new Error("Invalid Server installation record");
    return record;
  }
  if (explicit) return describeInstallation(explicit);
  const sibling = path.resolve(__dirname, "../../server");
  if (existsSync(path.join(sibling, "package.json")))
    return describeInstallation(sibling);
  let globalRoot: string;
  try {
    globalRoot = execFileSync("npm", ["root", "-g"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new ServerNotInstalledError();
  }
  const candidate = path.join(globalRoot, "@runweave/server");
  if (!existsSync(path.join(candidate, "package.json")))
    throw new ServerNotInstalledError();
  return describeInstallation(candidate);
}

export function materializeServer(
  packageRoot: string,
  home: string,
): { release: string; manifest: ServerReleaseManifest } {
  describeInstallation(packageRoot);
  const runtime = createRequire(__filename)(
    path.join(packageRoot, "bin/runtime.cjs"),
  ) as { materialize: (installed: string, home: string) => string };
  const release = runtime.materialize(packageRoot, home);
  const manifest = JSON.parse(
    readFileSync(path.join(release, "server-manifest.json"), "utf8"),
  ) as ServerReleaseManifest;
  if (manifest.managementApiVersion !== 1)
    throw new Error(
      "SERVER_API_INCOMPATIBLE: update @runweave/cli to manage this Server",
    );
  return { release, manifest };
}

export function activateServer(
  home: string,
  release: string,
  installation: ServerInstallation,
): void {
  const current = path.join(home, "current");
  const temporary = `${current}.${randomUUID()}`;
  symlinkSync(release, temporary);
  renameSync(temporary, current);
  const record = path.join(home, "installation.json");
  const staged = `${record}.${randomUUID()}`;
  writeFileSync(staged, JSON.stringify(installation, null, 2) + "\n", {
    mode: 0o600,
  });
  renameSync(staged, record);
}
