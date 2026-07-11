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
  if (
    typeof value.source?.root !== "string" ||
    !path.isAbsolute(value.source.root)
  ) {
    throw new DevSessionError("manifest source.root must be absolute", 4);
  }
  if (!value.services || typeof value.services !== "object") {
    throw new DevSessionError("manifest services are missing", 4);
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
    createdAt: validated.createdAt,
    updatedAt: validated.updatedAt,
    failure: validated.failure ?? null,
  };
}
