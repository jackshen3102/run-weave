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
    return {
      status: "completed",
      ownerRunId,
      ownerDispatchId,
      ownedRunIds: [],
      cancelledRunIds: [],
      ownedLiveFixtureRuns: 0,
      cleanupErrors: [],
      resourceLedger: emptyResourceLedger(manifest.devSessionId),
      completedAt: new Date().toISOString(),
      error: null,
    };
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
      completedAt: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
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
