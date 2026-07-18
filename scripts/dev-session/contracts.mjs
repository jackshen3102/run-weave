import path from "node:path";

export const DEV_SESSION_SCHEMA_VERSION = 1;
export const DEV_SESSION_STATES = [
  "planned",
  "starting",
  "ready",
  "stopping",
  "stopped",
  "failed",
  "stale",
];
export const DEV_SESSION_PROFILES = [
  "frontend",
  "fullstack",
  "app-server",
  "electron",
  "beta",
];
export const DEV_SESSION_OWNERSHIPS = [
  "dedicated",
  "shared-declared",
  "disabled",
];
export const DEV_SESSION_SURFACES = ["web", "desktop", "terminal-browser"];

const DEV_SESSION_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const BETA_INSTANCE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export class DevSessionError extends Error {
  constructor(message, exitCode = 1, details = undefined) {
    super(message);
    this.name = "DevSessionError";
    this.exitCode = exitCode;
    this.details = details;
  }
}

export function assertDevSessionId(value) {
  if (typeof value !== "string" || !DEV_SESSION_ID_PATTERN.test(value)) {
    throw new DevSessionError(
      "dev session id must be 1-48 lowercase letters, numbers, or hyphens",
      2,
      { value },
    );
  }
  return value;
}

export function assertBetaInstanceId(value) {
  if (typeof value !== "string" || !BETA_INSTANCE_ID_PATTERN.test(value)) {
    throw new DevSessionError(
      "Beta instance id must be 1-32 lowercase letters, numbers, or hyphens",
      2,
      { value },
    );
  }
  return value;
}

export function assertProfile(value) {
  if (!DEV_SESSION_PROFILES.includes(value)) {
    throw new DevSessionError(`unsupported profile: ${String(value)}`, 2, {
      allowed: DEV_SESSION_PROFILES,
    });
  }
  return value;
}

export function assertOwnership(value) {
  if (!DEV_SESSION_OWNERSHIPS.includes(value)) {
    throw new DevSessionError(`unsupported ownership: ${String(value)}`, 2, {
      allowed: DEV_SESSION_OWNERSHIPS,
    });
  }
  return value;
}

export function assertSurface(value) {
  if (!DEV_SESSION_SURFACES.includes(value)) {
    throw new DevSessionError(`unsupported surface: ${String(value)}`, 2, {
      allowed: DEV_SESSION_SURFACES,
    });
  }
  return value;
}

export function assertLoopbackUrl(value, label = "endpoint") {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new DevSessionError(`${label} must be a valid URL`, 4, { value });
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "ws:") ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  ) {
    throw new DevSessionError(`${label} must use a loopback HTTP/WS URL`, 4, {
      value,
    });
  }
  if (url.username || url.password) {
    throw new DevSessionError(`${label} must not contain credentials`, 4);
  }
  return url.toString().replace(/\/$/, "");
}

export function assertPathInside(parentPath, candidatePath, label = "path") {
  const parent = path.resolve(parentPath);
  const candidate = path.resolve(candidatePath);
  if (candidate !== parent && !candidate.startsWith(`${parent}${path.sep}`)) {
    throw new DevSessionError(`${label} escapes its allowed root`, 4, {
      parent,
      candidate,
    });
  }
  return candidate;
}

export function validateManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DevSessionError("manifest must be an object", 4);
  }
  if (value.schemaVersion !== DEV_SESSION_SCHEMA_VERSION) {
    throw new DevSessionError(
      `unsupported manifest schema: ${String(value.schemaVersion)}`,
      4,
    );
  }
  assertDevSessionId(value.devSessionId);
  assertProfile(value.profile);
  if (!DEV_SESSION_STATES.includes(value.state)) {
    throw new DevSessionError(
      `unsupported manifest state: ${String(value.state)}`,
      4,
    );
  }
  if (value.controlPlane?.appChannel !== "stable") {
    throw new DevSessionError("manifest control plane must be stable", 4);
  }
  if (value.controlPlane?.agentTeamDispatchId != null) {
    if (
      typeof value.controlPlane.agentTeamRunId !== "string" ||
      !value.controlPlane.agentTeamRunId ||
      typeof value.controlPlane.agentTeamDispatchId !== "string" ||
      !value.controlPlane.agentTeamDispatchId ||
      !Array.isArray(value.controlPlane.agentTeamCaseIds) ||
      value.controlPlane.agentTeamCaseIds.length === 0 ||
      value.controlPlane.agentTeamCaseIds.some(
        (caseId) => typeof caseId !== "string" || !caseId,
      ) ||
      typeof value.controlPlane.fixtureNamespace !== "string" ||
      !value.controlPlane.fixtureNamespace
    ) {
      throw new DevSessionError(
        "manifest Agent Team fixture scope is incomplete",
        4,
      );
    }
  }
  if (value.fixtureCleanup != null) {
    const cleanup = value.fixtureCleanup;
    if (
      !cleanup ||
      typeof cleanup !== "object" ||
      !["completed", "not_required_shared_backend", "failed"].includes(
        cleanup.status,
      ) ||
      (cleanup.completionBasis != null &&
        ![
          "session_never_started",
          "session_never_started_backfill",
          "shared_backend",
          "cleanup_endpoint",
          "cleanup_endpoint_failed",
          "beta_slot_reset",
          "beta_slot_reset_backfill",
        ].includes(cleanup.completionBasis)) ||
      !Number.isInteger(cleanup.ownedLiveFixtureRuns) ||
      cleanup.ownedLiveFixtureRuns < 0
    ) {
      throw new DevSessionError(
        "manifest fixture cleanup receipt is invalid",
        4,
      );
    }
    if (cleanup.resourceLedger != null) {
      const ledger = cleanup.resourceLedger;
      const stringArrayFields = [
        "runIds",
        "terminalSessionIds",
        "panelIds",
        "outboxIds",
      ];
      if (
        !ledger ||
        typeof ledger !== "object" ||
        ledger.devSessionId !== value.devSessionId ||
        stringArrayFields.some(
          (field) =>
            !Array.isArray(ledger[field]) ||
            ledger[field].some(
              (item) => typeof item !== "string" || !item,
            ),
        )
      ) {
        throw new DevSessionError(
          "manifest fixture resource ledger is invalid",
          4,
        );
      }
    }
  }
  if (
    typeof value.source?.root !== "string" ||
    !path.isAbsolute(value.source.root)
  ) {
    throw new DevSessionError("manifest source.root must be absolute", 4);
  }
  if (!value.services || typeof value.services !== "object") {
    throw new DevSessionError("manifest services are missing", 4);
  }
  if (
    value.profile === "beta" &&
    value.targetEnvironment?.betaSlot === undefined &&
    /^pool-0[1-5]$/.test(value.targetEnvironment?.instanceId ?? "")
  ) {
    throw new DevSessionError("pooled Beta manifest is missing betaSlot", 4);
  }
  if (value.profile === "beta" && value.targetEnvironment?.betaSlot) {
    const betaSlot = value.targetEnvironment?.betaSlot;
    const assignmentPending =
      ["planned", "failed", "stopped"].includes(value.state) &&
      betaSlot?.assignedSlotId === null &&
      betaSlot?.leaseNonce === null;
    if (
      betaSlot?.policy !== "fixed-pool-v1" ||
      betaSlot.capacity !== 5 ||
      (!assignmentPending &&
        (!/^pool-0[1-5]$/.test(betaSlot.assignedSlotId ?? "") ||
          typeof betaSlot.leaseNonce !== "string" ||
          !betaSlot.leaseNonce ||
          value.targetEnvironment.instanceId !== betaSlot.assignedSlotId)) ||
      (assignmentPending &&
        value.targetEnvironment.instanceId !== betaSlot.requestedSlotId) ||
      (betaSlot.requestedSlotId !== null &&
        !/^pool-0[1-5]$/.test(betaSlot.requestedSlotId)) ||
      (!assignmentPending &&
        betaSlot.requestedSlotId !== null &&
        betaSlot.requestedSlotId !== betaSlot.assignedSlotId)
    ) {
      throw new DevSessionError("manifest Beta slot contract is invalid", 4);
    }
    if (!assignmentPending) {
      const slotServices = [
        value.services.frontend,
        value.services.backend,
        value.services.appServer,
        value.services.electron,
        value.services.beta,
        value.services.cdp?.desktop,
        value.services.cdp?.terminalBrowser,
      ];
      if (
        slotServices.some(
          (service) =>
            service?.slotId !== betaSlot.assignedSlotId ||
            service?.leaseNonce !== betaSlot.leaseNonce,
        )
      ) {
        throw new DevSessionError(
          "manifest Beta service slot identity is inconsistent",
          4,
        );
      }
    }
  }
  return value;
}

export function publicManifest(manifest) {
  const validated = validateManifest(manifest);
  return {
    schemaVersion: validated.schemaVersion,
    devSessionId: validated.devSessionId,
    state: validated.state,
    profile: validated.profile,
    selectedBy: validated.selectedBy,
    controlPlane: validated.controlPlane,
    targetEnvironment: validated.targetEnvironment,
    source: validated.source,
    services: validated.services,
    impacts: validated.impacts,
    fixtureCleanup: validated.fixtureCleanup ?? null,
    createdAt: validated.createdAt,
    updatedAt: validated.updatedAt,
    failure: validated.failure ?? null,
  };
}
