import { spawn } from "node:child_process";
import os from "node:os";
import { inspectResources, protectsBackend, pythonEntry } from "./snapshot.mjs";
import {
  assertExpectedVersion,
  ownershipVersion,
  sessionIdentity,
  slotIdentity,
} from "./identity.mjs";
import { inspectBetaPool } from "../dev-session/beta-pool/projection.mjs";
import { readManifest } from "../dev-session/registry.mjs";
import {
  isProcessLive,
  processIdentityMatches,
} from "../dev-session/services/runtime.mjs";
import { inspectSessionServices } from "../dev-session/services/index.mjs";
import { runStop } from "../dev-session/commands/stop.mjs";
import {
  updateManifest,
  retainsBetaSlotLease,
} from "../dev-session/commands/manifest.mjs";
import { recoverBetaPoolSlot } from "../dev-session/beta-pool/recovery/index.mjs";
import { resolveBetaPaths } from "../beta/state.mjs";
import { stopManagedBeta } from "../beta/stop-control.mjs";

function conflict(message) {
  const error = new Error(message);
  error.status = 409;
  throw error;
}

function assertControlOwner(manifest, backendPid) {
  if (!manifest || protectsBackend(manifest, backendPid))
    conflict("请从另一个控制连接停止当前 Backend 所属 Session");
  if (["planned", "starting", "stopping"].includes(manifest.state))
    conflict("资源正在启动或清理，请稍后手动刷新");
}

async function stopBeta(manifest) {
  const slot = manifest.targetEnvironment?.betaSlot?.assignedSlotId;
  if (!slot)
    throw new Error("非池 Beta 资料不支持固定控制入口，请检查资源身份");
  const paths = resolveBetaPaths(
    manifest.source.root,
    os.homedir(),
    slot,
    manifest.devSessionId,
  );
  await stopManagedBeta(paths, {
    sharedAppServer: manifest.services.appServer?.ownership !== "dedicated",
    sourceRevision: manifest.source.revision,
  });
}

async function releaseSimulator(request, context) {
  const resource = (await inspectResources(context)).simulators.resources.find(
    (item) => item.id === request.resourceId,
  );
  if (!resource) {
    const error = new Error("资源不存在");
    error.status = 404;
    throw error;
  }
  assertExpectedVersion(
    resource.ownershipVersion,
    request.expectedOwnershipVersion,
  );
  if (resource.release.action !== request.action)
    conflict("清理条件已变化，请刷新后重新确认");
  // Only a fixed executable and stdin payload; the Python side re-reads the owner under its guard.
  return await new Promise((resolve, reject) => {
    const child = spawn("python3", ["-B", pythonEntry, "release"], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", () => {
      try {
        const value = JSON.parse(stdout);
        if (value.status === 409) conflict(value.message);
        resolve(value);
      } catch (error) {
        reject(error);
      }
    });
    // Resource projection returns only its generation-bound digest; obtain the raw digest in the Python process.
    child.stdin.end(
      JSON.stringify({
        resourceId: request.resourceId,
        action: request.action,
        expectedOwnershipVersion: request.expectedOwnershipVersion,
        generation: context.generation,
      }),
    );
  });
}

export async function releaseResource(request, context) {
  const snapshot = await inspectResources(context);
  const resources = [
    ...snapshot.desktop.resources,
    ...snapshot.desktop.sessions,
    ...snapshot.simulators.resources,
  ];
  const resource = resources.find((item) => item.id === request.resourceId);
  if (!resource) {
    const error = new Error("资源不存在");
    error.status = 404;
    throw error;
  }
  assertExpectedVersion(
    resource.ownershipVersion,
    request.expectedOwnershipVersion,
  );
  if (resource.release.action !== request.action)
    conflict(
      resource.release.disabledReason || "清理条件已变化，请刷新后重新确认",
    );
  if (resource.kind === "simulator") return releaseSimulator(request, context);
  const ownerId = resource.owner?.id;
  if (!ownerId) conflict("资源归属未知，无法释放");
  const manifest = await readManifest(ownerId);
  assertControlOwner(manifest, context.backendPid);
  const verify = async (current) => {
    assertControlOwner(current, context.backendPid);
    if (
      Object.values(current.services).some(
        (service) =>
          service?.ownership === "dedicated" &&
          service.process?.pid > 1 &&
          isProcessLive(service.process.pid) &&
          !processIdentityMatches(service.process),
      )
    )
      conflict("进程身份已变化，未执行释放");
    if (resource.kind === "desktop-slot") {
      const slot = (await inspectBetaPool()).slots.find(
        (item) => `slot:${item.slotId}` === resource.id,
      );
      assertExpectedVersion(
        ownershipVersion(context.generation, slotIdentity(slot)),
        request.expectedOwnershipVersion,
      );
      if (
        slot.manifest.readState !== "valid" ||
        current.devSessionId !== slot.lease.owner.sessionId ||
        current.targetEnvironment?.betaSlot?.leaseNonce !==
          slot.lease.owner.leaseNonce
      )
        conflict("占用身份不一致，未执行释放");
    } else
      assertExpectedVersion(
        ownershipVersion(context.generation, sessionIdentity(current)),
        request.expectedOwnershipVersion,
      );
    const inspection = await inspectSessionServices(current.services);
    if (request.action === "stop-and-release" && inspection.stale)
      conflict("资源状态已变化，请刷新后检查");
    return { observedStale: inspection.stale };
  };
  if (
    resource.kind === "desktop-slot" &&
    request.action === "release-occupancy"
  ) {
    const receipt = await recoverBetaPoolSlot({
      slotId: resource.id.slice(5),
      sessionId: ownerId,
      verifyOwnership: async (_slot, current) => {
        await verify(current);
      },
      stopBetaControl: stopBeta,
    });
    if (receipt.result !== "recovered")
      return {
        state: "blocked",
        message:
          "清理未完成，资源仍被保留：" + (receipt.blockedBy ?? []).join("；"),
      };
  } else {
    await runStop(
      {
        sessionId: ownerId,
        cleanupStale: request.action === "release-occupancy",
        json: true,
        verifyOwnership: verify,
      },
      manifest.source.root,
      {
        updateManifest,
        retainsBetaSlotLease,
        printResult: () => {},
        buildStaleRecovery: (_id, _services, stale) => ({
          action: "cleanup-stale-session",
          staleServices: stale,
        }),
        stopBetaControl: () => stopBeta(manifest),
      },
    );
  }
  const after = await inspectResources(context);
  const remaining = [
    ...after.desktop.resources,
    ...after.desktop.sessions,
  ].find((item) => item.id === resource.id);
  return !remaining || remaining.state === "free"
    ? { state: "released", message: "测试资源已停止并释放" }
    : {
        state: "blocked",
        message: remaining.reason || "后置核查尚未确认释放，请检查占用信息",
      };
}
