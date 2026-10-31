import type { ServerMaintenanceLease } from "@runweave/shared/server-management";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import {
  identity,
  readJson,
  requestJson,
  runChecked,
  settings,
  verifyRelease,
  writeJson,
  type ServerContext,
} from "./context.js";
import { foregroundControl } from "./processes.js";
import { registered, serviceStart, serviceStop } from "./services.js";
import {
  activateServer,
  describeInstallation,
  materializeServer,
  type ServerInstallation,
} from "./installation.js";

export async function protectedRestart<T>(
  ctx: ServerContext,
  force: boolean,
  action: () => Promise<T>,
): Promise<T> {
  if (!identity(ctx, "backend")) return action();
  const owner = randomUUID();
  const url = settings(ctx).localUrl + "/api/server/maintenance";
  const headers = {
    "x-runweave-server-token": readFileSync(
      path.join(ctx.home, "management-token"),
      "utf8",
    ).trim(),
    "x-runweave-server-owner": owner,
  };
  let lease: ServerMaintenanceLease | null = null;
  let timer: NodeJS.Timeout | undefined;
  let renewalError: Error | null = null;
  try {
    try {
      lease = (await requestJson(url, {
        method: "POST",
        headers,
      })) as ServerMaintenanceLease;
    } catch (error) {
      if (!force) throw error;
      process.stderr.write(
        "Forcing restart: maintenance status unavailable; impact is unknown\n",
      );
    }
    if (lease?.affectedRuns.length) {
      process.stderr.write(
        JSON.stringify({ affectedRuns: lease.affectedRuns }) + "\n",
      );
      if (!force)
        throw new Error(
          "SERVER_TASKS_ACTIVE: retry after affected executions finish, or use --force",
        );
    }
    if (lease) {
      const id = lease.leaseId;
      timer = setInterval(() => {
        void requestJson(`${url}/${id}/renew`, {
          method: "POST",
          headers,
        }).catch((error) => {
          renewalError = error as Error;
        });
      }, 30_000);
      timer.unref();
    }
    if (renewalError) throw renewalError;
    return await action();
  } finally {
    if (timer) clearInterval(timer);
    if (lease)
      await requestJson(`${url}/${lease.leaseId}`, {
        method: "DELETE",
        headers,
      }).catch(() => {});
  }
}

/** CLI owns activation; installing a Server never replaces the CLI executable. */
export async function updateServer(
  ctx: ServerContext,
  version: string | undefined,
  force: boolean,
  sourcePackage?: string,
): Promise<void> {
  if (version && !/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("--version must be an exact numeric semantic version");
  if (version && sourcePackage)
    throw new Error("Choose --version or --server-package, not both");
  const stage = mkdtempSync(path.join(ctx.home, ".update-"));
  const receipt = path.join(ctx.home, "update.json");
  const record = (phase: string, extra: Record<string, unknown> = {}) =>
    writeJson(receipt, {
      schemaVersion: 1,
      phase,
      fromVersion: ctx.manifest.version,
      requestedVersion: version ?? "latest",
      at: new Date().toISOString(),
      ...extra,
    });
  try {
    if (!sourcePackage)
      await runChecked("npm", [
        "install",
        "--prefix",
        stage,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        `@runweave/server@${version ?? "latest"}`,
      ]);
    const candidate = sourcePackage
      ? describeInstallation(sourcePackage).packageRoot
      : path.join(stage, "node_modules/@runweave/server");
    const target = materializeServer(candidate, ctx.home).release;
    const manifest = verifyRelease(target);
    // Conservative first-stage downgrade gate: schema sources must match the active release.
    // Forward releases are currently held to the same gate until migrations declare compatibility.
    if (manifest.dataCompatibility !== ctx.manifest.dataCompatibility)
      throw new Error(
        "SERVER_DATA_INCOMPATIBLE: this release does not declare compatibility with the active data schema",
      );
    await runChecked(process.execPath, [
      path.join(target, "server/index.cjs"),
      "inspect",
      ...ctx.configArgs,
    ]);
    record("staged", { targetVersion: manifest.version });
    const foregroundOwner = identity(ctx, "foreground");
    const wasRunning =
      !!identity(ctx, "backend") || !!identity(ctx, "app-server");
    const managed = registered(ctx);
    await protectedRestart(ctx, force, async () => {
      record("stopping", { targetVersion: manifest.version });
      if (wasRunning && managed) await serviceStop(ctx);
      if (wasRunning && foregroundOwner) await foregroundControl(ctx, "pause");
      if (wasRunning && !managed && !foregroundOwner)
        throw new Error("Unmanaged component owner; refusing to update");
      record("installing", { targetVersion: manifest.version });
      let installation: ServerInstallation;
      if (sourcePackage) installation = describeInstallation(candidate);
      else {
        const npmPrefix = ctx.installation.npmPrefix;
        const managedPrefix = path.join(ctx.home, "npm");
        await runChecked("npm", [
          "install",
          ...(npmPrefix ? ["-g"] : []),
          "--prefix",
          npmPrefix ?? managedPrefix,
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          `@runweave/server@${manifest.version}`,
        ]);
        const installed = path.join(
          npmPrefix ?? managedPrefix,
          npmPrefix
            ? "lib/node_modules/@runweave/server"
            : "node_modules/@runweave/server",
        );
        const installedVersion = readJson<{ version: string }>(
          path.join(installed, "package.json"),
        ).version;
        if (installedVersion !== manifest.version)
          throw new Error("Installed npm version differs from staged release");
        installation = describeInstallation(installed);
      }
      activateServer(ctx.home, target, installation);
      record("activating", { targetVersion: manifest.version });
      const nextContext = { ...ctx, release: target, manifest };
      if (wasRunning && managed) await serviceStart(nextContext);
      else if (foregroundOwner) await foregroundControl(ctx, "restart");
      record(wasRunning ? "healthy" : "activated", {
        targetVersion: manifest.version,
      });
    });
  } catch (error) {
    record(
      (error as Error).message.startsWith("SERVER_TASKS_ACTIVE")
        ? "blocked"
        : "failed",
      { error: (error as Error).message },
    );
    throw error;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
