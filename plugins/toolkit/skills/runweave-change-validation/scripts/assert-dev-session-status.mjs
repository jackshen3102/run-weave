#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const status = JSON.parse(readFileSync(args.file, "utf8"));
const errors = [];
const checkedServices = [];

expectEqual(status.devSessionId, args.session, "devSessionId", errors);
expectEqual(status.state, "ready", "state", errors);
expectEqual(
  status.controlPlane?.appChannel,
  "stable",
  "controlPlane.appChannel",
  errors,
);

if (
  typeof status.source?.root !== "string" ||
  path.resolve(status.source.root) !== path.resolve(args.sourceRoot)
) {
  errors.push(
    `source.root mismatch: expected ${path.resolve(args.sourceRoot)}, received ${String(status.source?.root)}`,
  );
}
if (typeof status.source?.revision !== "string" || !status.source.revision) {
  errors.push("source.revision must be present");
}
if (args.profile) {
  expectEqual(status.profile, args.profile, "profile", errors);
  expectEqual(
    status.targetEnvironment?.kind,
    args.profile,
    "targetEnvironment.kind",
    errors,
  );
}
if (
  args.surface &&
  !status.targetEnvironment?.acceptanceSurfaces?.includes(args.surface)
) {
  errors.push(`targetEnvironment does not include surface ${args.surface}`);
}

for (const [name, service] of listServices(status.services)) {
  checkedServices.push(name);
  validateService(name, service, args.session, status.source?.revision, errors);
}

const result = {
  healthy: errors.length === 0,
  devSessionId: status.devSessionId ?? null,
  profile: status.profile ?? null,
  checkedServices,
  errors,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (errors.length > 0) {
  process.exitCode = 1;
}

function parseArgs(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!value || !flag?.startsWith("--")) {
      fail(
        "usage: assert-dev-session-status.mjs --file <path> --session <id> --source-root <path> --profile <profile> --surface <surface>",
      );
    }
    const key = flag
      .slice(2)
      .replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    options[key] = value;
  }
  for (const key of ["file", "session", "sourceRoot", "profile", "surface"]) {
    if (!options[key]) {
      fail(
        `missing required argument --${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`,
      );
    }
  }
  return options;
}

function listServices(services) {
  if (!services || typeof services !== "object") {
    return [];
  }
  return [
    ["frontend", services.frontend],
    ["backend", services.backend],
    ["appServer", services.appServer],
    ["electron", services.electron],
    ["beta", services.beta],
    ["cdp.desktop", services.cdp?.desktop],
    ["cdp.terminalBrowser", services.cdp?.terminalBrowser],
  ];
}

function validateService(name, service, sessionId, sourceRevision, errors) {
  if (!service || typeof service !== "object") {
    errors.push(`${name} service is missing`);
    return;
  }
  if (
    !new Set(["dedicated", "shared-declared", "disabled"]).has(
      service.ownership,
    )
  ) {
    errors.push(`${name}.ownership is invalid`);
    return;
  }
  if (service.ownership === "disabled") {
    return;
  }
  if (
    typeof service.serviceInstanceId !== "string" ||
    !service.serviceInstanceId
  ) {
    errors.push(`${name}.serviceInstanceId must be present`);
  }
  if (service.ownership === "dedicated") {
    expectEqual(
      service.ownerDevSessionId,
      sessionId,
      `${name}.ownerDevSessionId`,
      errors,
    );
    if (!Number.isInteger(service.pid) || service.pid < 1) {
      errors.push(`${name}.pid must be a positive integer`);
    }
    expectEqual(
      service.sourceRevision,
      sourceRevision,
      `${name}.sourceRevision`,
      errors,
    );
  }
  if (!name.startsWith("cdp.") && service.health !== "live") {
    errors.push(
      `${name}.health must be live, received ${String(service.health)}`,
    );
  }
  if (service.healthFailureReason) {
    errors.push(
      `${name}.healthFailureReason: ${String(service.healthFailureReason)}`,
    );
  }
  if (name.startsWith("cdp.") && !isLoopbackHttpUrl(service.endpoint)) {
    errors.push(`${name}.endpoint must be a loopback HTTP URL`);
  }
}

function isLoopbackHttpUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

function expectEqual(actual, expected, label, errors) {
  if (actual !== expected) {
    errors.push(
      `${label} mismatch: expected ${expected}, received ${String(actual)}`,
    );
  }
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}
