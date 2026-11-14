import { CONFIGURATION_COMPATIBILITY, supportsConfiguration, type ConfigurationUpgradePreview, type ConfigurationUpgradeResult } from "@runweave/shared/configuration";
import { BACKEND_CORE_CONFIGURATION_DOMAINS, resolveActiveServerRelease, withConfigurationUpgradeOwnership } from "@runweave/config-node";
import { PtyHostClient } from "@runweave/pty-host/client";
import type { PtyHostSession } from "@runweave/shared/terminal/pty-host";
import { execFileSync } from "node:child_process";
import type { ServerMaintenanceLease, ServerConfigurationObservation } from "@runweave/shared/server-management";
import { createHash, randomUUID } from "node:crypto";
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
import { foregroundControl } from "./control.js";
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
  forUpgrade = false,
): Promise<T> {
  if (!identity(ctx, "backend")) return action();
  const owner = randomUUID();
  const url = settings(ctx, forUpgrade).localUrl + "/api/server/maintenance";
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

function candidateConfiguration<T>(ctx: ServerContext, target: string, command: string, args: string[] = []): T {
  try {
    return JSON.parse(execFileSync(process.execPath, [path.join(target, "server/index.cjs"), command, ...ctx.configArgs, ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, maxBuffer: 1024 * 1024,
    })) as T;
  } catch (error) {
    const diagnostic = String((error as { stderr?: unknown }).stderr ?? "");
    let detail: { code?: string; fields?: string[] } = {};
    try { detail = JSON.parse(diagnostic); } catch { /* Non-configuration failures stay redacted. */ }
    if (/^CONFIG_[A-Z_]+$/.test(detail.code ?? "") && Array.isArray(detail.fields) && detail.fields.every(field => typeof field === "string"))
      throw new Error(`${detail.code}${detail.fields.length ? `: ${detail.fields.join(", ")}` : ""}`);
    const code = diagnostic.match(/CONFIG_[A-Z_]+/)?.[0];
    throw new Error(code ?? "SERVER_CONFIGURATION_PREFLIGHT_FAILED");
  }
}

/** CLI owns activation; installing a Server never replaces the CLI executable. */
export async function updateServer(
  ctx: ServerContext,
  version: string | undefined,
  force: boolean,
  sourcePackage?: string,
  dryRun = false,
  execution?: { transactionId: string; controls: { pause(): Promise<void>; restart(): Promise<void> } },
  channel: "latest" | "next" = "latest",
): Promise<unknown> {
  if (version && !/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("--version must be an exact numeric semantic version");
  if (version && sourcePackage)
    throw new Error("Choose --version or --server-package, not both");
  const stage = mkdtempSync(path.join(ctx.home, ".update-"));
  const receipt = path.join(ctx.home, "update.json");
  let configuration: ConfigurationUpgradePreview | ConfigurationUpgradeResult | undefined;
  let lastPhase = "preflight";
  const transactionId = execution?.transactionId ?? randomUUID();
  let hostLease: PtyHostClient | undefined;
  let resumeOriginal: (() => Promise<void>) | undefined;
  const record = (phase: string, extra: Record<string, unknown> = {}) =>
    writeJson(receipt, {
      schemaVersion: 1,
      transactionId,
      phase,
      configuration,
      fromRelease: ctx.release,
      configurationReceipt: path.join(ctx.context.configRoot, "config-upgrade.json"),
      fromVersion: ctx.manifest.version,
      requestedVersion: version ?? channel,
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
        `@runweave/server@${version ?? channel}`,
      ]);
    const candidate = sourcePackage
      ? describeInstallation(sourcePackage).packageRoot
      : path.join(stage, "node_modules/@runweave/server");
    const target = materializeServer(candidate, ctx.home).release;
    const manifest = verifyRelease(target);
    let hostIdentity: { hostInstanceId: string; sessions: { terminalSessionId: string; sessionInstanceId: string; pid: number }[] } | undefined;
    if (process.platform === "win32") {
      if (manifest.ptyHost?.protocolVersion !== 1) throw new Error("HOST_PROTOCOL_INCOMPATIBLE: target requires a maintenance upgrade");
      if (identity(ctx, "backend")) {
        const host = await PtyHostClient.connect(ctx.context);
        try {
          hostIdentity = { hostInstanceId: host.descriptor.hostInstanceId,
            // Exited entries are a bounded cache, not live processes to preserve.
            sessions: (await host.request<PtyHostSession[]>("listSessions"))
              .filter(session => session.status === "running") };
        } finally { host.close(); }
      }
    }
    const hasUpgrade = manifest.configurationUpgradeVersion === 1;
    const databaseCompatible = hasUpgrade && manifest.databaseCompatibility
      ? ctx.manifest.databaseCompatibility
        ? manifest.databaseCompatibility === ctx.manifest.databaseCompatibility
          || manifest.databaseUpgradeFrom?.includes(ctx.manifest.databaseCompatibility)
        : manifest.legacyDataCompatibility?.includes(ctx.manifest.dataCompatibility)
          || manifest.dataCompatibility === ctx.manifest.dataCompatibility
      : manifest.dataCompatibility === ctx.manifest.dataCompatibility;
    if (!databaseCompatible)
      throw new Error(
        "SERVER_DATA_INCOMPATIBLE: this release does not declare compatibility with the active data schema",
      );
    await runChecked(process.execPath, [
      path.join(target, "server/index.cjs"),
      "inspect",
      ...ctx.configArgs,
    ]);
    if (hasUpgrade) {
      configuration = candidateConfiguration<ConfigurationUpgradePreview>(ctx, target, "config-plan");
      if (!supportsConfiguration(CONFIGURATION_COMPATIBILITY, configuration.target))
        throw new Error("CONFIG_UPGRADE_CLI_INCOMPATIBLE: install a matching CLI before switching Server");
      if (configuration.changed)
        withConfigurationUpgradeOwnership(ctx.context, () => {}, ["backend", "app-server"]);
    }
    const foregroundOwner = identity(ctx, "foreground");
    const wasRunning =
      !!identity(ctx, "backend") || !!identity(ctx, "app-server");
    const managed = registered(ctx);
    const foregroundCapability = foregroundOwner?.configuration ?? {
      format: "runweave-yaml", schemaVersions: [1],
      domainVersions: Object.fromEntries(Object.keys(configuration?.target.domainVersions ?? {}).map(domain => [domain, [1]])),
    };
    if (configuration && foregroundOwner && !supportsConfiguration(foregroundCapability, configuration.target))
      throw new Error("CONFIG_UPGRADE_FOREGROUND_INCOMPATIBLE: stop the foreground owner, update, then start with the matching CLI");
    if (wasRunning && !managed && !foregroundOwner)
      throw new Error("Unmanaged component owner; refusing to update");
    if (dryRun) return { dryRun: true, fromVersion: ctx.manifest.version, targetVersion: manifest.version, databaseCompatible: true, configuration: configuration ?? null, restartRequired: wasRunning };
    record("staged", { targetVersion: manifest.version });
    await protectedRestart(ctx, force, async () => {
      if (process.platform === "win32" && hostIdentity) {
        hostLease = await PtyHostClient.connect(ctx.context);
        if (hostLease.descriptor.hostInstanceId !== hostIdentity.hostInstanceId) throw new Error("HOST_IDENTITY_MISMATCH");
        await hostLease.request("freeze", { frozen: true });
        hostIdentity.sessions = await hostLease.request("listSessions");
      }
      lastPhase = "stopping";
      record(lastPhase, { targetVersion: manifest.version });
      if (wasRunning && managed) await serviceStop(ctx);
      if (wasRunning && foregroundOwner) await (execution ? execution.controls.pause() : foregroundControl(ctx, "pause"));
      if (wasRunning && !managed && !foregroundOwner)
        throw new Error("Unmanaged component owner; refusing to update");
      if (wasRunning) resumeOriginal = async () => {
        await hostLease?.request("freeze", { frozen: false });
        if (managed) await serviceStart(ctx);
        else if (foregroundOwner) await (execution ? execution.controls.restart() : foregroundControl(ctx, "restart"));
      };
      lastPhase = "installing";
      record(lastPhase, { targetVersion: manifest.version });
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
            ? process.platform === "win32" ? "node_modules/@runweave/server" : "lib/node_modules/@runweave/server"
            : "node_modules/@runweave/server",
        );
        const installedVersion = readJson<{ version: string }>(
          path.join(installed, "package.json"),
        ).version;
        if (installedVersion !== manifest.version)
          throw new Error("Installed npm version differs from staged release");
        installation = describeInstallation(installed);
      }
      // The candidate owns historical parsing. CAS rechecks the preflight snapshot
      // after all managed readers stop and before publishing the target configuration.
      if (configuration) {
        lastPhase = "migrating";
        record(lastPhase, { targetVersion: manifest.version });
        configuration = candidateConfiguration<ConfigurationUpgradeResult>(ctx, target, "config-apply", [
          "--expected-revision", String(configuration.expectedRevision),
          "--expected-digest", configuration.expectedDigest,
        ]);
        record("configuration-committed", { targetVersion: manifest.version });
      }
      lastPhase = "activating";
      activateServer(ctx.home, target, installation);
      record("activating", { targetVersion: manifest.version });
      const nextContext = { ...ctx, release: target, manifest };
      await hostLease?.request("freeze", { frozen: false });
      if (wasRunning && managed) await serviceStart(nextContext);
      else if (foregroundOwner) await (execution ? execution.controls.restart() : foregroundControl(ctx, "restart"));
      if (hostIdentity) {
        const host = await PtyHostClient.connect(ctx.context);
        try {
          if (host.descriptor.hostInstanceId !== hostIdentity.hostInstanceId) throw new Error("HOST_IDENTITY_MISMATCH");
          const after = await host.request<{ terminalSessionId: string; sessionInstanceId: string; pid: number }[]>("listSessions");
          if (hostIdentity.sessions.some(before => !after.some(session => session.terminalSessionId === before.terminalSessionId &&
            session.sessionInstanceId === before.sessionInstanceId && session.pid === before.pid))) throw new Error("HOST_IDENTITY_MISMATCH");
        } finally { host.close(); }
      }
      let backendConfigurationVerified = false;
      if (wasRunning && configuration && "savedRevision" in configuration) {
        const committed = configuration;
        lastPhase = "verifying-configuration";
        record(lastPhase, { targetVersion: manifest.version });
        const observation = await requestJson(settings(nextContext).localUrl + "/api/server/configuration", {
          headers: {
            "x-runweave-server-token": readFileSync(path.join(ctx.home, "management-token"), "utf8").trim(),
            "x-runweave-server-owner": transactionId,
          },
        }) as ServerConfigurationObservation;
        if (observation.diskError || observation.digest !== committed.digest || observation.savedRevision !== committed.savedRevision
          || BACKEND_CORE_CONFIGURATION_DOMAINS.some(domain => observation.consumers[domain]?.state !== "applied"
            || observation.consumers[domain]?.appliedRevision !== committed.savedRevision))
          throw new Error("CONFIG_UPGRADE_NOT_APPLIED: Backend core consumers have not adopted the saved configuration");
        backendConfigurationVerified = true;
      }
      record(wasRunning ? "healthy" : "activated", {
        targetVersion: manifest.version,
        backendConfigurationVerified,
      });
    }, true);
  } catch (error) {
    let recovery: string | undefined;
    if (resumeOriginal && configuration) {
      try {
        const digest = createHash("sha256").update(readFileSync(path.join(ctx.context.configRoot, "settings.yaml"))).digest("hex");
        if (digest === configuration.expectedDigest && resolveActiveServerRelease(ctx.home) === ctx.release) {
          await resumeOriginal();
          recovery = "original-services-resumed";
        } else recovery = "manual-recovery-required";
      } catch { recovery = "manual-recovery-required"; }
    }
    if (!dryRun) record(
      (error as Error).message.startsWith("SERVER_TASKS_ACTIVE")
        ? "blocked"
        : "failed",
      { failedPhase: lastPhase, recovery, error: (error as Error).message },
    );
    throw error;
  } finally {
    if (hostLease) {
      await hostLease.request("freeze", { frozen: false }).catch(() => {});
      hostLease.close();
    }
    rmSync(stage, { recursive: true, force: true });
  }
}
