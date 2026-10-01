import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  bundleID,
  DeviceError,
  hash,
  pkg,
  readJSON,
  writeJSON,
} from "../device/support.mjs";

export const stateRoot = resolve(homedir(), ".runweave/ios-update");
export const targetPath = resolve(stateRoot, "target.json");
export const validVersion = (value) =>
  /^\d+\.\d+\.\d+$/.test(value) &&
  value.split(".").every((part) => Number.isSafeInteger(Number(part)));
export function compareVersions(a, b) {
  if (!validVersion(a) || !validVersion(b))
    throw new Error("Expected a three-part product version");
  const left = a.split(".").map(Number),
    right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++)
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}
export function buildNumber(value) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)))
    throw new Error(
      `Unsupported build number: ${value}; expected a non-negative integer`,
    );
  return Number(value);
}
export function readTarget() {
  if (!existsSync(targetPath)) return {};
  const value = readJSON(targetPath);
  if (
    value.schemaVersion !== 1 ||
    !value.device ||
    !value.team ||
    !value.configuration
  )
    throw new Error(`Invalid target configuration: ${targetPath}`);
  return value;
}
export function saveTarget(options) {
  writeJSON(targetPath, {
    schemaVersion: 1,
    device: options.device,
    team: options.team,
    configuration: options.configuration,
  });
}
// Shared across worktrees. Unknown ownership is never reclaimed automatically.
export function acquireStateLock(name, runId) {
  const path = resolve(stateRoot, "locks", name);
  mkdirSync(resolve(path, ".."), { recursive: true });
  try {
    mkdirSync(path);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new DeviceError(
      "update_busy",
      "checking",
      `Inspect ${path}/owner.json before retrying`,
      3,
      path,
    );
  }
  writeJSON(resolve(path, "owner.json"), {
    runId,
    pid: process.pid,
    worktree: realpathSync(pkg),
  });
  return () => {
    if (readJSON(resolve(path, "owner.json")).runId !== runId)
      throw new Error("Update lock owner changed");
    rmSync(path, { recursive: true });
  };
}
export const buildLockName = () => `build-${hash(realpathSync(pkg))}`;
export function highestVersion(...versions) {
  return versions
    .filter(Boolean)
    .reduce((latest, version) =>
      compareVersions(latest, version) >= 0 ? latest : version,
    );
}
export function nextPatchVersion(version) {
  const parts = version.split(".").map(Number);
  parts[2] += 1;
  if (!parts.every(Number.isSafeInteger))
    throw new Error("Product version exhausted");
  return parts.join(".");
}
function readVersionState() {
  const file = resolve(stateRoot, "versions", `${bundleID}.json`);
  const previous = existsSync(file)
    ? readJSON(file)
    : { schemaVersion: 1, last: 0 };
  if (
    previous.schemaVersion !== 1 ||
    (previous.lastVersion !== undefined && !validVersion(previous.lastVersion))
  )
    throw new Error("Invalid version counter state");
  buildNumber(previous.last);
  return previous;
}
export function previewNewVersion(baseVersion, installedVersion) {
  return nextPatchVersion(
    highestVersion(
      baseVersion,
      installedVersion,
      readVersionState().lastVersion,
    ),
  );
}
export function allocateVersion({
  minimumBuild,
  baseVersion,
  installedVersion,
  requestedVersion,
  runId,
}) {
  const release = acquireStateLock(`version-${bundleID}`, runId);
  try {
    const file = resolve(stateRoot, "versions", `${bundleID}.json`);
    const previous = readVersionState();
    const baseline = highestVersion(
      baseVersion,
      installedVersion,
      previous.lastVersion,
    );
    const version = requestedVersion || nextPatchVersion(baseline);
    if (
      requestedVersion &&
      (compareVersions(version, baseline) < 0 ||
        [installedVersion, previous.lastVersion]
          .filter(Boolean)
          .some((used) => compareVersions(version, used) <= 0))
    )
      throw new DeviceError(
        "product_version_already_used",
        "planning",
        "Use a newer --version or omit it for automatic patch increment",
        2,
      );
    const next =
      Math.max(buildNumber(previous.last), buildNumber(minimumBuild)) + 1;
    if (!Number.isSafeInteger(next)) throw new Error("Build number exhausted");
    writeJSON(file, { schemaVersion: 1, last: next, lastVersion: version });
    return { version, buildNumber: String(next) };
  } finally {
    release();
  }
}
