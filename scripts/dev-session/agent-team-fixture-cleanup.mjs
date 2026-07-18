import { readFile } from "node:fs/promises";
import path from "node:path";

import { DevSessionError, assertLoopbackUrl } from "./contracts.mjs";

export async function cleanupOwnedAgentTeamFixtures(manifest) {
  const ownerRunId = manifest.controlPlane?.agentTeamRunId;
  const ownerDispatchId = manifest.controlPlane?.agentTeamDispatchId;
  if (!ownerRunId || !ownerDispatchId) {
    return null;
  }
  const backend = manifest.services?.backend;
  if (
    manifest.state === "planned" ||
    (manifest.state === "failed" && !backend?.url)
  ) {
    return completedEmptyReceipt(manifest, {
      ownerRunId,
      ownerDispatchId,
      completionBasis: "session_never_started",
    });
  }
  if (backend?.ownership !== "dedicated") {
    return {
      status: "not_required_shared_backend",
      ownerRunId,
      ownerDispatchId,
      ownedRunIds: [],
      cancelledRunIds: [],
      ownedLiveFixtureRuns: 0,
      cleanupErrors: [],
      resourceLedger: emptyResourceLedger(manifest.devSessionId),
      completionBasis: "shared_backend",
      completedAt: new Date().toISOString(),
      error: null,
    };
  }
  const baseUrl = assertLoopbackUrl(backend.url, "fixture Backend URL");
  try {
    const auth = await resolveCleanupAuth(manifest, baseUrl);
    const response = await requestCleanup(baseUrl, auth.accessToken, {
      ownerRunId,
      ownerDispatchId,
      reason: `Dev Session ${manifest.devSessionId} is stopping`,
    });
    const cleanupErrors = Array.isArray(response.cleanupErrors)
      ? response.cleanupErrors
      : [];
    const ownedLiveFixtureRuns = Number(response.ownedLiveFixtureRuns);
    if (!Number.isInteger(ownedLiveFixtureRuns) || ownedLiveFixtureRuns < 0) {
      throw new Error("fixture cleanup returned an invalid live Run count");
    }
    const failed = ownedLiveFixtureRuns > 0 || cleanupErrors.length > 0;
    const runs = Array.isArray(response.runs) ? response.runs : [];
    return {
      status: failed ? "failed" : "completed",
      ownerRunId,
      ownerDispatchId,
      ownedRunIds: runs
        .map((run) => run?.runId)
        .filter((runId) => typeof runId === "string"),
      cancelledRunIds: Array.isArray(response.cancelledRunIds)
        ? response.cancelledRunIds.filter((runId) => typeof runId === "string")
        : [],
      ownedLiveFixtureRuns,
      cleanupErrors,
      resourceLedger: buildResourceLedger(manifest.devSessionId, runs),
      completionBasis: "cleanup_endpoint",
      completedAt: failed ? null : new Date().toISOString(),
      error: failed
        ? `fixture cleanup left ${ownedLiveFixtureRuns} live Runs and ${cleanupErrors.length} resource errors`
        : null,
    };
  } catch (error) {
    return {
      status: "failed",
      ownerRunId,
      ownerDispatchId,
      ownedRunIds: [],
      cancelledRunIds: [],
      ownedLiveFixtureRuns: 1,
      cleanupErrors: [],
      resourceLedger: emptyResourceLedger(manifest.devSessionId),
      completionBasis: "cleanup_endpoint_failed",
      completedAt: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function completeOwnedAgentTeamFixturesAfterBetaSlotReset(manifest) {
  const ownerRunId = manifest.controlPlane?.agentTeamRunId;
  const ownerDispatchId = manifest.controlPlane?.agentTeamDispatchId;
  const betaSlot = manifest.targetEnvironment?.betaSlot;
  if (
    !ownerRunId ||
    !ownerDispatchId ||
    manifest.profile !== "beta" ||
    typeof betaSlot?.assignedSlotId !== "string" ||
    !betaSlot.assignedSlotId ||
    typeof betaSlot.leaseNonce !== "string" ||
    !betaSlot.leaseNonce
  ) {
    return null;
  }
  return completedEmptyReceipt(manifest, {
    ownerRunId,
    ownerDispatchId,
    completionBasis: "beta_slot_reset",
  });
}

export function backfillOwnedAgentTeamFixturesForStoppedSession(manifest) {
  const ownerRunId = manifest.controlPlane?.agentTeamRunId;
  const ownerDispatchId = manifest.controlPlane?.agentTeamDispatchId;
  if (!ownerRunId || !ownerDispatchId || manifest.state !== "stopped") {
    return null;
  }
  const betaSlot = manifest.targetEnvironment?.betaSlot;
  const neverStartedServices = [
    "frontend",
    "backend",
    "appServer",
    "electron",
    "beta",
  ].map((serviceName) => manifest.services?.[serviceName]);
  if (
    manifest.profile === "beta" &&
    manifest.targetEnvironment?.instanceId === null &&
    betaSlot?.assignedSlotId === null &&
    betaSlot?.leaseNonce === null &&
    neverStartedServices.every(
      (service) =>
        service?.ownership === "dedicated" &&
        service.url == null &&
        service.pid == null &&
        service.slotId == null &&
        service.leaseNonce == null,
    )
  ) {
    return withCompletionEvidence(
      manifest.fixtureCleanup ??
        completedEmptyReceipt(manifest, {
          ownerRunId,
          ownerDispatchId,
          completionBasis: "session_never_started",
        }),
      "session_never_started_backfill",
      {
        stoppedAt: manifest.updatedAt ?? null,
        instanceId: null,
        assignedSlotId: null,
        leaseNonce: null,
      },
    );
  }
  const terminalStatuses = new Set([
    "already-stopped",
    "already-stopped-no-slot-processes",
    "stopped-identity-verified",
  ]);
  const serviceNames = ["frontend", "backend", "appServer", "electron"];
  const dedicatedServices = serviceNames
    .map((serviceName) => [serviceName, manifest.services?.[serviceName]])
    .filter(([, service]) => service?.ownership === "dedicated");
  if (
    dedicatedServices.length === 0 ||
    dedicatedServices.some(
      ([, service]) => !terminalStatuses.has(service.cleanupStatus),
    )
  ) {
    return null;
  }
  const receipt = completeOwnedAgentTeamFixturesAfterBetaSlotReset(manifest);
  if (!receipt) {
    return null;
  }
  return withCompletionEvidence(
    manifest.fixtureCleanup ?? receipt,
    "beta_slot_reset_backfill",
    {
      stoppedAt: manifest.updatedAt ?? null,
      serviceCleanupStatuses: Object.fromEntries(
        dedicatedServices.map(([serviceName, service]) => [
          serviceName,
          service.cleanupStatus,
        ]),
      ),
    },
  );
}

function withCompletionEvidence(receipt, completionBasis, cleanupEvidence) {
  if (receipt?.status !== "completed") {
    return null;
  }
  return { ...receipt, completionBasis, cleanupEvidence };
}

function completedEmptyReceipt(
  manifest,
  { ownerRunId, ownerDispatchId, completionBasis },
) {
  return {
    status: "completed",
    ownerRunId,
    ownerDispatchId,
    ownedRunIds: [],
    cancelledRunIds: [],
    ownedLiveFixtureRuns: 0,
    cleanupErrors: [],
    resourceLedger: emptyResourceLedger(manifest.devSessionId),
    completionBasis,
    completedAt: new Date().toISOString(),
    error: null,
  };
}

function buildResourceLedger(devSessionId, runs) {
  const runIds = [];
  const terminalSessionIds = [];
  const panelIds = [];
  const outboxIds = [];
  for (const run of runs) {
    if (!run || typeof run !== "object") continue;
    const runId = typeof run.runId === "string" ? run.runId : null;
    const projectId = typeof run.projectId === "string" ? run.projectId : null;
    const terminalSessionId =
      typeof run.terminalSessionId === "string"
        ? run.terminalSessionId
        : null;
    if (runId) runIds.push(runId);
    if (terminalSessionId) terminalSessionIds.push(terminalSessionId);
    if (typeof run.mainPanelId === "string") {
      panelIds.push(run.mainPanelId);
    }
    const workers = Array.isArray(run.workers) ? run.workers : [];
    for (const worker of workers) {
      const panelId =
        typeof worker?.panelId === "string" ? worker.panelId : null;
      if (!panelId) continue;
      panelIds.push(panelId);
      if (projectId && terminalSessionId) {
        outboxIds.push(`${projectId}:${terminalSessionId}:panel:${panelId}`);
      }
    }
  }
  return {
    devSessionId,
    runIds: unique(runIds),
    terminalSessionIds: unique(terminalSessionIds),
    panelIds: unique(panelIds),
    outboxIds: unique(outboxIds),
  };
}

function emptyResourceLedger(devSessionId) {
  return {
    devSessionId,
    runIds: [],
    terminalSessionIds: [],
    panelIds: [],
    outboxIds: [],
  };
}

function unique(values) {
  return Array.from(new Set(values));
}

async function resolveCleanupAuth(manifest, baseUrl) {
  const configPath = manifest.services?.electron?.userDataDir
    ? path.join(manifest.services.electron.userDataDir, "cli", "config.json")
    : null;
  if (configPath) {
    try {
      const config = JSON.parse(await readFile(configPath, "utf8"));
      const profileName = config.activeProfile || "beta";
      const profile = config.profiles?.[profileName] ?? config.profiles?.beta;
      if (profile?.accessToken) {
        return { accessToken: profile.accessToken };
      }
      if (profile?.refreshToken) {
        const refreshed = await requestAuth(baseUrl, "/api/auth/refresh", {
          refreshToken: profile.refreshToken,
        });
        if (refreshed.accessToken) {
          return { accessToken: refreshed.accessToken };
        }
      }
    } catch {
      // Fall through to the dedicated local Backend credentials.
    }
  }
  const login = await requestAuth(baseUrl, "/api/auth/login", {
    username: "admin",
    password: "admin",
  });
  if (!login.accessToken) {
    throw new DevSessionError("fixture Backend login returned no token", 5);
  }
  return { accessToken: login.accessToken };
}

async function requestAuth(baseUrl, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-auth-client": "electron",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`${route} returned HTTP ${response.status}`);
  }
  return response.json();
}

async function requestCleanup(baseUrl, accessToken, body) {
  const response = await fetch(
    `${baseUrl}/api/agent-team/fixture-scopes/cleanup`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `fixture cleanup returned HTTP ${response.status}: ${detail.slice(0, 500)}`,
    );
  }
  return response.json();
}
