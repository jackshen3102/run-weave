import { lstat, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTeamFixtureDevSessionCleanup } from "@runweave/shared/agent-team";

interface DevSessionFixtureCleanupPayload {
  status?: unknown;
  ownedLiveFixtureRuns?: unknown;
  resourceLedger?: unknown;
  error?: unknown;
}

interface DevSessionManifestPayload {
  devSessionId?: unknown;
  state?: unknown;
  controlPlane?: {
    agentTeamRunId?: unknown;
    agentTeamDispatchId?: unknown;
  };
  fixtureCleanup?: DevSessionFixtureCleanupPayload | null;
}

export async function listOwnedAgentTeamDevSessions(
  ownerRunId: string,
  ownerDispatchId?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentTeamFixtureDevSessionCleanup[]> {
  const root = path.resolve(
    env.RUNWEAVE_DEV_SESSION_HOME?.trim() ||
      path.join(os.homedir(), ".runweave", "dev-sessions"),
  );
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: AgentTeamFixtureDevSessionCleanup[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(root, entry.name, "manifest.json");
    try {
      const stats = await lstat(manifestPath);
      if (!stats.isFile() || stats.isSymbolicLink()) continue;
      const manifest = JSON.parse(
        await readFile(manifestPath, "utf8"),
      ) as DevSessionManifestPayload;
      if (
        manifest.controlPlane?.agentTeamRunId !== ownerRunId ||
        typeof manifest.controlPlane.agentTeamDispatchId !== "string" ||
        (ownerDispatchId != null &&
          manifest.controlPlane.agentTeamDispatchId !== ownerDispatchId)
      ) {
        continue;
      }
      const cleanup = manifest.fixtureCleanup;
      const cleanupStatus =
        typeof cleanup?.status === "string" ? cleanup.status : null;
      const ownedLiveFixtureRuns =
        typeof cleanup?.ownedLiveFixtureRuns === "number" &&
        Number.isInteger(cleanup.ownedLiveFixtureRuns) &&
        cleanup.ownedLiveFixtureRuns >= 0
          ? cleanup.ownedLiveFixtureRuns
          : null;
      const state =
        typeof manifest.state === "string" ? manifest.state : "invalid";
      const devSessionId =
        typeof manifest.devSessionId === "string"
          ? manifest.devSessionId
          : entry.name;
      const resourceLedger = normalizeResourceLedger(
        cleanup?.resourceLedger,
        devSessionId,
      );
      const invalidResourceLedger =
        cleanup?.resourceLedger != null && resourceLedger == null;
      const completed =
        state === "stopped" &&
        !invalidResourceLedger &&
        (cleanupStatus === "completed" ||
          cleanupStatus === "not_required_shared_backend") &&
        (ownedLiveFixtureRuns === 0 ||
          cleanupStatus === "not_required_shared_backend");
      results.push({
        devSessionId,
        state,
        cleanupStatus,
        ownedLiveFixtureRuns,
        resourceLedger,
        error: completed
          ? null
          : invalidResourceLedger
            ? `Dev Session ${entry.name} has an invalid fixture resource ledger`
            : typeof cleanup?.error === "string" && cleanup.error
              ? cleanup.error
              : `Dev Session ${entry.name} has not completed fixture cleanup`,
      });
    } catch {
      // Invalid or newer manifests are not attributed without a valid owner.
    }
  }
  return results.sort((left, right) =>
    left.devSessionId.localeCompare(right.devSessionId),
  );
}

function normalizeResourceLedger(value: unknown, devSessionId: string) {
  if (value == null) {
    return null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const ledger = value as Record<string, unknown>;
  if (ledger.devSessionId !== devSessionId) {
    return null;
  }
  const fields = [
    "runIds",
    "terminalSessionIds",
    "panelIds",
    "outboxIds",
  ] as const;
  if (
    fields.some(
      (field) =>
        !Array.isArray(ledger[field]) ||
        ledger[field].some((item) => typeof item !== "string" || !item),
    )
  ) {
    return null;
  }
  return {
    devSessionId,
    runIds: ledger.runIds as string[],
    terminalSessionIds: ledger.terminalSessionIds as string[],
    panelIds: ledger.panelIds as string[],
    outboxIds: ledger.outboxIds as string[],
  };
}
