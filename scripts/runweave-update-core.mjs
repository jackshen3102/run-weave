import os from "node:os";
import path from "node:path";

export const APP_UPDATE_REASON_NO_STATE =
  "No previous local update state was found; using a full app update so Electron shell changes are not missed.";

export const APP_UPDATE_REASON_SHELL_VERSION =
  "The source Electron shell version is newer than the installed app version.";

export const APP_UPDATE_REASON_NATIVE_CHANGE =
  "Electron shell/native files changed since the last local update.";

export const RUNTIME_UPDATE_REASON =
  "Only runtime-loadable files changed since the last local update.";

export const APP_SERVER_UPDATE_REASON_NO_STATE =
  "No previous app-server update state was found; updating the global app-server runtime.";

export const APP_SERVER_UPDATE_REASON_CHANGE =
  "App-server files changed since the last local update.";

export const APP_SERVER_UPDATE_REASON_EXPLICIT =
  "App-server update was requested explicitly.";

export const APP_SERVER_SKIP_REASON_EXPLICIT =
  "App-server update was skipped explicitly.";

export const APP_SERVER_SKIP_REASON_NO_CHANGE =
  "No app-server files changed since the last local update.";
export const RUNWEAVE_CODESIGN_IDENTITY_ENV = "RUNWEAVE_CODESIGN_IDENTITY";
export const BETA_UPDATE_APP_NAME = "Runweave Beta";
export const BETA_UPDATE_BUILDER_CONFIG = "electron-builder.beta.yml";
const BETA_INSTANCE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export function assertBetaInstanceId(value) {
  if (typeof value !== "string" || !BETA_INSTANCE_ID_PATTERN.test(value)) {
    throw new Error(
      "Beta instance id must be 1-32 lowercase letters, numbers, or hyphens",
    );
  }
  return value;
}

export function resolveBetaAppName(instanceId) {
  return `${BETA_UPDATE_APP_NAME} ${assertBetaInstanceId(instanceId)}`;
}

export const INSTALLED_APP_CONTROL_PATH_PREFIXES = [
  "electron/resources/",
  "electron/scripts/",
  "electron/electron-builder.yml",
  "electron/electron-builder.beta.yml",
  "electron/electron-builder.local-updates.yml",
  "electron/package.json",
  "electron/tsconfig.json",
  "scripts/electron-dist-retry.mjs",
  "scripts/electron-local-update.mjs",
  "scripts/publish-local-updates.mjs",
  "scripts/runweave-update",
  "scripts/runweave-beta.mjs",
  "scripts/serve-local-updates.mjs",
];

export const APP_SENSITIVE_PATH_PREFIXES = [
  "electron/src/",
  ...INSTALLED_APP_CONTROL_PATH_PREFIXES,
];

export const APP_SERVER_SENSITIVE_PATH_PREFIXES = [
  "app-server/",
  "packages/runweave-cli/src/commands/app-server.ts",
  "packages/shared/src/app-server",
  "packages/shared/src/index.ts",
  "scripts/install-app-server-runtime.mjs",
  "scripts/install-runweave-bin-shim.mjs",
  "scripts/verify-app-server-cli-start.mjs",
  "scripts/verify-app-server-event-center.mjs",
];

export function commandName(binary, platform = process.platform) {
  return platform === "win32" ? `${binary}.cmd` : binary;
}

export function withTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

export function resolveDefaultRuntimeHome(homeDir = os.homedir()) {
  if (!homeDir) {
    throw new Error("Cannot resolve user home directory");
  }

  return path.join(
    homeDir,
    "Library",
    "Application Support",
    "@runweave",
    "electron",
    "runtime",
  );
}

export function resolveDefaultUpdateStatePath(homeDir = os.homedir()) {
  if (!homeDir) {
    throw new Error("Cannot resolve user home directory");
  }

  return path.join(
    homeDir,
    "Library",
    "Application Support",
    "RunweaveLocalUpdate",
    "state.json",
  );
}

export function resolveBetaUpdateTargets(
  homeDir = os.homedir(),
  instanceId = "default",
) {
  if (!homeDir) {
    throw new Error("Cannot resolve user home directory");
  }

  const safeInstanceId = assertBetaInstanceId(instanceId);
  const appName = resolveBetaAppName(safeInstanceId);
  const instanceRoot = path.join(
    homeDir,
    "Library",
    "Application Support",
    BETA_UPDATE_APP_NAME,
    "instances",
    safeInstanceId,
  );
  const userData = path.join(instanceRoot, "user-data");
  return {
    appName,
    appPath: path.join("/Applications", `${appName}.app`),
    appServerHome: path.join(
      homeDir,
      ".runweave",
      "app-server-beta",
      safeInstanceId,
    ),
    bundleId: `com.runweave.desktop.beta.${safeInstanceId}`,
    instanceId: safeInstanceId,
    instanceRoot,
    runtimeHome: path.join(userData, "runtime"),
    statePath: path.join(userData, "update", "state.json"),
    userData,
  };
}

export function validateUpdateTargetIsolation({
  appBackupPath,
  appName,
  appPath,
  appServerHome,
  channel,
  electronBuilderConfig,
  homeDir = os.homedir(),
  instanceId = process.env.RUNWEAVE_DESKTOP_INSTANCE_ID ?? "default",
  runtimeHome,
  statePath,
}) {
  if (channel !== "beta") {
    return;
  }

  const expected = resolveBetaUpdateTargets(homeDir, instanceId);
  const checks = [
    ["app name", appName, expected.appName],
    ["app path", path.resolve(appPath), path.resolve(expected.appPath)],
    [
      "runtime home",
      path.resolve(runtimeHome),
      path.resolve(expected.runtimeHome),
    ],
    [
      "App Server home",
      path.resolve(appServerHome),
      path.resolve(expected.appServerHome),
    ],
    ["state path", path.resolve(statePath), path.resolve(expected.statePath)],
    [
      "Electron builder config",
      electronBuilderConfig,
      BETA_UPDATE_BUILDER_CONFIG,
    ],
  ];
  for (const [label, actual, expectedValue] of checks) {
    if (actual !== expectedValue) {
      throw new Error(
        `Refusing Beta update: ${label} must be ${expectedValue}; received ${actual}`,
      );
    }
  }
  if (appBackupPath) {
    const backupPrefix = path.join(
      "/Applications",
      `.${expected.appName}.app.previous`,
    );
    const resolvedBackupPath = path.resolve(appBackupPath);
    if (
      resolvedBackupPath !== backupPrefix &&
      !resolvedBackupPath.startsWith(`${backupPrefix}-`)
    ) {
      throw new Error(
        `Refusing Beta update: app backup path must be ${backupPrefix} or a timestamped child; received ${resolvedBackupPath}`,
      );
    }
  }
}

export function isAppSensitivePath(filePath) {
  const normalized = filePath.split(path.sep).join("/");
  return APP_SENSITIVE_PATH_PREFIXES.some((prefix) => {
    return normalized === prefix || normalized.startsWith(prefix);
  });
}

export function isInstalledAppControlPath(filePath) {
  const normalized = filePath.split(path.sep).join("/");
  return INSTALLED_APP_CONTROL_PATH_PREFIXES.some((prefix) => {
    return normalized === prefix || normalized.startsWith(prefix);
  });
}

export function isAppServerSensitivePath(filePath) {
  const normalized = filePath.split(path.sep).join("/");
  return APP_SERVER_SENSITIVE_PATH_PREFIXES.some((prefix) => {
    return normalized === prefix || normalized.startsWith(prefix);
  });
}

export function uniqueSorted(values) {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

export function filterChangedFilesAgainstSnapshot({
  candidateFiles,
  currentSnapshot,
  previousSnapshot,
}) {
  const files = uniqueSorted(candidateFiles ?? []);
  if (!previousSnapshot || typeof previousSnapshot !== "object") {
    return files;
  }

  return files.filter((filePath) => {
    if (!Object.hasOwn(previousSnapshot, filePath)) {
      return true;
    }
    return currentSnapshot?.[filePath] !== previousSnapshot[filePath];
  });
}

function unquoteEnvValue(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function quoteEnvValue(value) {
  return JSON.stringify(value);
}

export function readDotenvValue(content, key) {
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*)\\s*$`);
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(pattern);
    if (!match) {
      continue;
    }
    const rawValue = match[1] ?? "";
    return unquoteEnvValue(rawValue.replace(/\s+#.*$/, ""));
  }
  return null;
}

export function upsertDotenvValue(content, key, value) {
  const lines = content ? content.split(/\r?\n/) : [];
  const nextLine = `${key}=${quoteEnvValue(value)}`;
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  let replaced = false;
  const nextLines = lines.map((line) => {
    if (!replaced && pattern.test(line)) {
      replaced = true;
      return nextLine;
    }
    return line;
  });

  if (!replaced) {
    if (nextLines.length > 0 && nextLines.at(-1) !== "") {
      nextLines.push("");
    }
    nextLines.push(nextLine);
  }

  return `${nextLines.join("\n").replace(/\n*$/, "")}\n`;
}

export function parseVersion(value) {
  return String(value)
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

export function compareVersions(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  const length = Math.max(leftParts.length, rightParts.length, 3);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart > rightPart) {
      return 1;
    }
    if (leftPart < rightPart) {
      return -1;
    }
  }

  return 0;
}

export function incrementMinorVersion(value) {
  const [major = 0, minor = 0] = parseVersion(value);
  return `${major}.${minor + 1}.0`;
}

export function resolveAppBuildVersion({
  installedAppVersion,
  sourceShellVersion,
}) {
  if (!installedAppVersion) {
    return sourceShellVersion;
  }

  return compareVersions(sourceShellVersion, installedAppVersion) > 0
    ? sourceShellVersion
    : incrementMinorVersion(installedAppVersion);
}

export function resolveUpdatePlan({
  appServerMode = "auto",
  changedFiles,
  forceMode = "auto",
  hasPreviousAppServerState,
  hasPreviousState,
  installedAppVersion,
  sourceShellVersion,
}) {
  if (!["auto", "runtime", "app"].includes(forceMode)) {
    throw new Error(`Unsupported update mode: ${forceMode}`);
  }
  if (!["auto", "update", "skip"].includes(appServerMode)) {
    throw new Error(`Unsupported app-server update mode: ${appServerMode}`);
  }

  const files = uniqueSorted(changedFiles ?? []);
  const nativeFiles = files.filter(isAppSensitivePath);
  const appServerFiles = files.filter(isAppServerSensitivePath);
  const appServer = resolveAppServerUpdatePlan({
    appServerFiles,
    appServerMode,
    hasPreviousAppServerState: hasPreviousAppServerState ?? hasPreviousState,
  });

  if (forceMode === "app") {
    return {
      appServer,
      mode: "app",
      reason: "App update was requested explicitly.",
      changedFiles: files,
      nativeFiles,
    };
  }

  if (forceMode === "runtime") {
    return {
      appServer,
      mode: "runtime",
      reason: "Runtime update was requested explicitly.",
      changedFiles: files,
      nativeFiles,
    };
  }

  if (!hasPreviousState) {
    return {
      appServer,
      mode: "app",
      reason: APP_UPDATE_REASON_NO_STATE,
      changedFiles: files,
      nativeFiles,
    };
  }

  if (
    installedAppVersion &&
    sourceShellVersion &&
    compareVersions(sourceShellVersion, installedAppVersion) > 0
  ) {
    return {
      appServer,
      mode: "app",
      reason: APP_UPDATE_REASON_SHELL_VERSION,
      changedFiles: files,
      nativeFiles,
    };
  }

  if (nativeFiles.length > 0) {
    return {
      appServer,
      mode: "app",
      reason: APP_UPDATE_REASON_NATIVE_CHANGE,
      changedFiles: files,
      nativeFiles,
    };
  }

  return {
    appServer,
    mode: "runtime",
    reason: RUNTIME_UPDATE_REASON,
    changedFiles: files,
    nativeFiles,
  };
}

function resolveAppServerUpdatePlan({
  appServerFiles,
  appServerMode,
  hasPreviousAppServerState,
}) {
  if (appServerMode === "update") {
    return {
      action: "update",
      changedFiles: appServerFiles,
      reason: APP_SERVER_UPDATE_REASON_EXPLICIT,
    };
  }

  if (appServerMode === "skip") {
    return {
      action: "skip",
      changedFiles: appServerFiles,
      reason: APP_SERVER_SKIP_REASON_EXPLICIT,
    };
  }

  if (!hasPreviousAppServerState) {
    return {
      action: "update",
      changedFiles: appServerFiles,
      reason: APP_SERVER_UPDATE_REASON_NO_STATE,
    };
  }

  if (appServerFiles.length > 0) {
    return {
      action: "update",
      changedFiles: appServerFiles,
      reason: APP_SERVER_UPDATE_REASON_CHANGE,
    };
  }

  return {
    action: "skip",
    changedFiles: appServerFiles,
    reason: APP_SERVER_SKIP_REASON_NO_CHANGE,
  };
}

export function validateResolvedUpdateOptions({
  noRestart,
  plan,
  verifyDesktop,
}) {
  if (noRestart && plan.mode === "app") {
    throw new Error(
      "--no-restart is only supported for runtime updates. App updates must quit and relaunch the target desktop app.",
    );
  }
  if (noRestart && plan.appServer?.action === "update") {
    throw new Error(
      "--no-restart cannot be combined with an App Server update because updating App Server requires rw app-server restart. Use --app-server=skip to skip App Server or rerun without --no-restart.",
    );
  }
  if (noRestart && verifyDesktop) {
    throw new Error(
      "--verify-desktop cannot be combined with --no-restart because desktop verification requires relaunching the target app.",
    );
  }
}

export { parseRunweaveUpdateArgs } from "./runweave-update-args.mjs";
