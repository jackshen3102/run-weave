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
export const RUNWEAVE_CODESIGN_IDENTITY_ENV = "RUNWEAVE_CODESIGN_IDENTITY";

export const APP_SENSITIVE_PATH_PREFIXES = [
  "electron/src/",
  "electron/resources/",
  "electron/scripts/",
  "electron/electron-builder.yml",
  "electron/electron-builder.local-updates.yml",
  "electron/package.json",
  "electron/tsconfig.json",
  "scripts/electron-dist-retry.mjs",
  "scripts/electron-local-update.mjs",
  "scripts/publish-local-updates.mjs",
  "scripts/runweave-update.mjs",
  "scripts/runweave-update-core.mjs",
  "scripts/runweave-update-test-cases.mjs",
  "scripts/serve-local-updates.mjs",
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

export function isAppSensitivePath(filePath) {
  const normalized = filePath.split(path.sep).join("/");
  return APP_SENSITIVE_PATH_PREFIXES.some((prefix) => {
    return normalized === prefix || normalized.startsWith(prefix);
  });
}

export function uniqueSorted(values) {
  return Array.from(new Set(values.filter(Boolean))).sort();
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
  changedFiles,
  forceMode = "auto",
  hasPreviousState,
  installedAppVersion,
  sourceShellVersion,
}) {
  if (!["auto", "runtime", "app"].includes(forceMode)) {
    throw new Error(`Unsupported update mode: ${forceMode}`);
  }

  const files = uniqueSorted(changedFiles ?? []);
  const nativeFiles = files.filter(isAppSensitivePath);

  if (forceMode === "app") {
    return {
      mode: "app",
      reason: "App update was requested explicitly.",
      changedFiles: files,
      nativeFiles,
    };
  }

  if (forceMode === "runtime") {
    return {
      mode: "runtime",
      reason: "Runtime update was requested explicitly.",
      changedFiles: files,
      nativeFiles,
    };
  }

  if (!hasPreviousState) {
    return {
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
      mode: "app",
      reason: APP_UPDATE_REASON_SHELL_VERSION,
      changedFiles: files,
      nativeFiles,
    };
  }

  if (nativeFiles.length > 0) {
    return {
      mode: "app",
      reason: APP_UPDATE_REASON_NATIVE_CHANGE,
      changedFiles: files,
      nativeFiles,
    };
  }

  return {
    mode: "runtime",
    reason: RUNTIME_UPDATE_REASON,
    changedFiles: files,
    nativeFiles,
  };
}

export function validateResolvedUpdateOptions({ noRestart, plan }) {
  if (noRestart && plan.mode === "app") {
    throw new Error(
      "--no-restart is only supported for runtime updates. App updates must quit and relaunch Runweave to replace /Applications/Runweave.app.",
    );
  }
}

export function parseRunweaveUpdateArgs(argv) {
  const result = {
    appPath: null,
    dryRun: false,
    mode: "auto",
    noRestart: false,
    runtimeHome: null,
    sourceRoot: process.cwd(),
    statePath: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = (name) => {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${name} requires a value`);
      }
      index += 1;
      return value;
    };

    if (arg === "--dry-run") {
      result.dryRun = true;
      continue;
    }
    if (arg === "--no-restart") {
      result.noRestart = true;
      continue;
    }
    if (arg === "--mode") {
      result.mode = readValue("--mode");
      continue;
    }
    if (arg.startsWith("--mode=")) {
      result.mode = arg.slice("--mode=".length);
      continue;
    }
    if (arg === "--repo" || arg === "--source-root") {
      result.sourceRoot = readValue(arg);
      continue;
    }
    if (arg.startsWith("--repo=")) {
      result.sourceRoot = arg.slice("--repo=".length);
      continue;
    }
    if (arg.startsWith("--source-root=")) {
      result.sourceRoot = arg.slice("--source-root=".length);
      continue;
    }
    if (arg === "--app-path") {
      result.appPath = readValue("--app-path");
      continue;
    }
    if (arg.startsWith("--app-path=")) {
      result.appPath = arg.slice("--app-path=".length);
      continue;
    }
    if (arg === "--runtime-home") {
      result.runtimeHome = readValue("--runtime-home");
      continue;
    }
    if (arg.startsWith("--runtime-home=")) {
      result.runtimeHome = arg.slice("--runtime-home=".length);
      continue;
    }
    if (arg === "--state-path") {
      result.statePath = readValue("--state-path");
      continue;
    }
    if (arg.startsWith("--state-path=")) {
      result.statePath = arg.slice("--state-path=".length);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return result;
}
