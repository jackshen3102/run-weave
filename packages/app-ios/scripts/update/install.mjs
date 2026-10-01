import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { bundleID, deviceQuery, readJSON } from "../device/support.mjs";
import { buildNumber, compareVersions } from "./state.mjs";

const installedApp = (apps) =>
  apps?.find((app) => app.bundleIdentifier === bundleID) ?? null;
const versionOf = (app) => ({
  version: app?.version ?? null,
  buildNumber: app?.bundleVersion ?? null,
  installationURL: app?.url ?? null,
});

export async function installAndLaunch({
  options,
  result,
  product,
  appPath,
  settings,
  report,
  dir,
  deviceLock,
  waitForUnlock,
  preflight,
  checked,
  fail,
  setPhase,
  inspect,
  source,
  sourceSnapshot,
  identityCLI,
  aborted,
  progress,
}) {
  setPhase("installing");
  const ready = await waitForUnlock(
    await preflight(options, resolve(dir, "before-install"), result.runId),
    "install",
  );
  if (ready.state === "blocked") fail(ready.error.reason, ready.nextAction, 3);
  const latest = ready.checks.find((c) => c.id === "installed_app");
  if (latest.status !== "pass")
    fail("app_metadata_unavailable", "Restore connectivity and retry", 3);
  if (
    latest.value &&
    (compareVersions(result.version, latest.value.version) < 0 ||
      buildNumber(product.buildNumber) < buildNumber(latest.value.bundleVersion))
  )
    fail("installed_version_changed", "Retry to allocate a newer build", 3);
  const verified = await inspect(appPath);
  if (verified.productSHA256 !== product.productSHA256)
    fail("artifact_changed", "Rebuild this product before installation", 4);
  if (JSON.stringify(await source()) !== JSON.stringify(sourceSnapshot))
    fail("source_changed", "Retry with stable sources", 4);
  result.install = "installing";
  progress(`安装到 ${result.name}（${result.transport}）`);
  const receiptPath = resolve(dir, "install.json");
  try {
    await checked(
      "xcrun",
      ["devicectl", "device", "install", "app", "--device", options.device, appPath, "--timeout", "180", "--json-output", receiptPath],
      "install",
      190000,
      5,
    );
  } catch (error) {
    if (existsSync(receiptPath) && !aborted()) {
      try {
        await checked("python3", ["-B", identityCLI, "record-install", "--app-path", appPath, "--receipt", receiptPath, "--device", report.device.identifier], "record-install-failure", 60000, 5);
      } catch { /* Keep the original installation error. */ }
    }
    result.install = "failed";
    throw error;
  }
  const receipt = readJSON(receiptPath);
  await checked("python3", ["-B", identityCLI, "record-install", "--app-path", appPath, "--receipt", receiptPath, "--device", report.device.identifier], "record-install", 60000, 5);
  result.install = "installed";
  const apps = await deviceQuery("apps", options.device, resolve(dir, "after-install"), 15000, deviceLock);
  const app = installedApp(apps.value?.apps);
  result.after = versionOf(app);
  const receiptApp = receipt.result.installedApplications.find((a) => a.bundleID === bundleID);
  const normalizeURL = (url) => url?.replace(/\/$/, "");
  if (!apps.ok || !app || app.version !== result.version || app.bundleVersion !== product.buildNumber || normalizeURL(app.url) !== normalizeURL(receiptApp.installationURL))
    fail("installed_identity_unverified", "Inspect install.json and after-install/apps.json before retrying", 5);
  result.install = "verified";
  setPhase("launching");
  result.launch = "launching";
  const launchPath = resolve(dir, "launch.json");
  await checked("xcrun", ["devicectl", "device", "process", "launch", "--device", options.device, "--terminate-existing", bundleID, "--timeout", "30", "--json-output", launchPath], "launch", 40000, 6);
  const launch = readJSON(launchPath);
  const pid = launch.result?.process?.processIdentifier;
  if (launch.info?.outcome !== "success" || launch.result?.deviceIdentifier !== report.device.identifier || !pid)
    fail("launch_unverified", "Inspect launch.json", 6);
  const processes = await deviceQuery("processes", options.device, resolve(dir, "after-launch"), 15000, deviceLock);
  const processInfo = processes.value?.runningProcesses?.find((p) => p.processIdentifier === pid);
  const expectedExecutable = new URL(`${app.url.replace(/\/$/, "")}/${settings.EXECUTABLE_NAME}`).pathname;
  const executablePath = (value) => value?.startsWith("file:") ? decodeURIComponent(new URL(value).pathname) : value;
  result.pid = pid;
  result.launch = "launched";
  if (!processes.ok || executablePath(processInfo?.executable) !== expectedExecutable || executablePath(launch.result.process.executable) !== expectedExecutable)
    fail("process_unverified", "Inspect after-launch/processes.json; installed App may have exited", 6);
  result.launch = "verified";
}
