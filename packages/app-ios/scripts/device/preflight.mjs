import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  bundleID,
  command,
  deviceQuery,
  project,
  timestamp,
  writeJSON,
} from "./support.mjs";
import { inspectLock } from "./lock.mjs";

export async function preflight(options, dir, ownRunId) {
  const observedAt = timestamp();
  const checks = [];
  const add = (id, status, source, reason, evidencePath, value) =>
    checks.push({
      id,
      status,
      source,
      ...(reason && { reason }),
      ...(evidencePath && { evidencePath }),
      ...(value !== undefined && { value }),
    });
  // All independent read-only queries share a 30 s budget (each has a 10 s timeout).
  const results = await Promise.allSettled([
    command("xcodebuild", ["-version"], { dir, name: "xcode" }),
    command("xcrun", ["--sdk", "iphoneos", "--show-sdk-version"], {
      dir,
      name: "sdk",
    }),
    command("security", ["find-identity", "-v", "-p", "codesigning"], {
      dir,
      name: "signing",
    }),
    ...["details", "lockState", "apps", "processes"].map((kind) =>
      deviceQuery(kind, options.device, dir),
    ),
  ]);
  const [xcode, sdk, signing, details, lock, apps, processes] = results.map(
    (r) => (r.status === "fulfilled" ? r.value : { ok: false }),
  );
  add(
    "toolchain",
    xcode.ok && sdk.ok ? "pass" : "blocked",
    "xcode-cli",
    xcode.ok && sdk.ok ? undefined : "toolchain_unavailable",
    xcode.evidencePath,
  );
  const device = details.ok ? details.value : null;
  const canonicalUDID = device?.hardwareProperties?.udid;
  const sameDevice = canonicalUDID === options.device;
  const live =
    sameDevice &&
    device?.connectionProperties?.tunnelState === "connected" &&
    lock.ok &&
    lock.value?.deviceIdentifier === device.identifier;
  add(
    "transport",
    live ? "pass" : "blocked",
    "devicectl-json",
    live ? undefined : "device_unavailable",
    details.evidencePath,
  );
  const paired = live && device.connectionProperties?.pairingState === "paired";
  add(
    "pairing",
    paired ? "pass" : "blocked",
    "devicectl-json",
    paired ? undefined : "pairing_unverified",
    details.evidencePath,
  );
  const development =
    live &&
    device.deviceProperties?.developerModeStatus === "enabled" &&
    device.deviceProperties?.ddiServicesAvailable === true;
  add(
    "development",
    development ? "pass" : "blocked",
    "devicectl-json",
    development ? undefined : "developer_services_unavailable",
    details.evidencePath,
  );
  const unlocked =
    live &&
    lock.value.passcodeRequired === false &&
    lock.value.unlockedSinceBoot === true;
  add(
    "unlocked",
    unlocked ? "pass" : "blocked",
    "lockState-json",
    unlocked
      ? undefined
      : live && lock.value.passcodeRequired === true
        ? "device_locked"
        : "lock_state_unknown",
    lock.evidencePath,
  );
  const teams = [
    ...new Set(
      [
        ...readFileSync(resolve(project, "project.pbxproj"), "utf8").matchAll(
          /DEVELOPMENT_TEAM\s*=\s*([A-Z0-9]+);/g,
        ),
      ].map((m) => m[1]),
    ),
  ];
  const team = options.team || (teams.length === 1 ? teams[0] : null);
  const signingAvailable =
    team &&
    signing.ok &&
    /\b[1-9]\d* valid identities found/.test(signing.output);
  add(
    "signing",
    signingAvailable ? "pass" : "blocked",
    "security-identities-and-project",
    signingAvailable
      ? "candidate_identity_requires_build_verification"
      : "signing_unavailable",
    signing.evidencePath,
  );
  add(
    "installed_app",
    apps.ok ? "pass" : "unknown",
    "devicectl-json",
    apps.ok
      ? "metadata_does_not_prove_build_identity"
      : "app_metadata_unavailable",
    apps.evidencePath,
    apps.value?.apps?.find((app) => app.bundleIdentifier === bundleID) || null,
  );
  const owner = inspectLock(options.device);
  add(
    "owner",
    owner && owner.runId !== ownRunId ? "blocked" : "pass",
    "user-level-lock",
    owner && owner.runId !== ownRunId ? "device_busy" : undefined,
    owner?.path,
    owner,
  );
  // A runner launched outside this tool is not covered by our user-level lock.
  const runners = processes.value?.runningProcesses?.filter((p) =>
    /(?:xctrunner|UIRunner-Runner|DeviceRunner-Runner)\.app\//i.test(
      p.executable || "",
    ),
  );
  add(
    "external_runner",
    !processes.ok ? "blocked" : runners?.length ? "blocked" : "pass",
    "devicectl-json",
    !processes.ok
      ? "process_identity_unknown"
      : runners?.length
        ? "device_busy"
        : undefined,
    processes.evidencePath,
    runners,
  );
  add(
    "runner_artifact",
    "unknown",
    "local-cache",
    "requires_explicit_suite_and_content_signature_validation",
  );
  add("ui_automation", "unknown", "not_probed", "requires_active_probe");
  const blocked = checks.filter((c) => c.status === "blocked");
  const reason =
    blocked.find((c) => c.reason === "device_busy")?.reason ||
    blocked.find((c) => c.reason === "device_unavailable")?.reason ||
    blocked.find((c) => c.reason === "device_locked")?.reason ||
    blocked[0]?.reason;
  const report = {
    schemaVersion: 1,
    state: blocked.length ? "blocked" : "preflight_ok",
    device: {
      udid: options.device,
      observedAt,
      identifier: device?.identifier,
      name: device?.deviceProperties?.name,
      osVersion: device?.deviceProperties?.osVersionNumber,
    },
    checks,
    team,
    toolchain: { xcode: xcode.output?.trim(), sdk: sdk.output?.trim() },
    nextAction:
      reason === "device_locked"
        ? "Unlock the target device, then run doctor again"
        : reason === "signing_unavailable"
          ? "Configure Xcode signing or provide --team"
          : blocked.length
            ? "Resolve blocked checks and run doctor again"
            : "run_explicit_suite",
    ...(blocked.length && {
      error: { phase: "checking", reason, evidencePath: dir },
    }),
  };
  writeJSON(resolve(dir, "doctor.json"), report);
  return report;
}
