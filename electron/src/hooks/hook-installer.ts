import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { constants as fsConstants } from "node:fs";
import { buildLauncherScript } from "./hook-launcher-script";
import {
  cleanupTraeTomlHookBlock,
  mergeJsonHookEntry,
  pruneSupersededCodexHooks,
  stripLegacyCodexNotifyKey,
} from "./hook-installer-config";

export { buildLauncherScript } from "./hook-launcher-script";
export {
  cleanupTraeTomlHookBlock,
  mergeJsonHookEntry,
  pruneSupersededCodexHooks,
  stripLegacyCodexNotifyKey,
} from "./hook-installer-config";

type JsonRecord = Record<string, unknown>;
type HookInstallerOptions = {
  homeDir?: string;
  resourcesDir?: string;
};

type HookInstallerContext = {
  homeDir: string;
  resourcesDir: string;
};

type JsonReadResult =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "valid"; value: JsonRecord };

const BRIDGE_BASENAME = "runweave-hook-bridge";
const LAUNCHER_SCRIPT_BASENAME = "runweave-hook-bridge.cjs";
const APP_SERVER_CLIENT_BASENAME = "app-server-client.cjs";
const LEGACY_BRIDGE_BASENAME = "browser-viewer-hook-bridge";
const BACKUP_SUFFIX = ".runweave-hook-backup";
const FEISHU_SCRIPT_BASENAME = "feishu_stop_notify.sh";
const RUNWEAVE_HOOK_MARKER = "_runweaveManaged";

const CLAUDE_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "Stop",
  "PermissionRequest",
  "Notification",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
];

export async function installHooksIfNeeded(
  options: HookInstallerOptions = {},
): Promise<void> {
  const context = resolveHookInstallerContext(options);
  if (!(await hasAnyConfigDir(context))) {
    return;
  }

  await installAllHooks(context);
}

export async function installAllHooks(
  options: HookInstallerOptions = {},
): Promise<void> {
  const context = resolveHookInstallerContext(options);
  await installNotifyAssets(context);
  await writeLauncherScript(context);
  // Phase 1: only codex + trae completion are supported end-to-end. Claude
  // installer stays in-source for a future re-enable but is not invoked yet,
  // so the green-dot path remains strictly limited to known AI CLIs.
  await installCodexHooks(context);
  await installTraeHooks(context);
}

export async function installNotifyAssets(
  options: HookInstallerOptions = {},
): Promise<void> {
  const context = resolveHookInstallerContext(options);
  const source = await resolveHookAssetPath(context, FEISHU_SCRIPT_BASENAME);
  if (!(await fileExists(source))) {
    return;
  }

  const targetDir = getNotifyHooksDir(context.homeDir);
  const target = getFeishuScriptPath(context.homeDir);
  await mkdir(targetDir, { recursive: true });
  await copyFile(source, target);
  await chmod(target, 0o755);
}

export async function writeLauncherScript(
  options: HookInstallerOptions = {},
): Promise<void> {
  const context = resolveHookInstallerContext(options);
  const launcherDir = getLauncherDir(context.homeDir);
  const launcherPath = getLauncherPath(context.homeDir);
  const launcherScript = await loadLauncherScript(context);
  const appServerClientSource = await resolveHookAssetPath(
    context,
    APP_SERVER_CLIENT_BASENAME,
  );

  await mkdir(launcherDir, { recursive: true });
  await writeFile(launcherPath, launcherScript, "utf8");
  await chmod(launcherPath, 0o755);
  if (await fileExists(appServerClientSource)) {
    await copyFile(
      appServerClientSource,
      path.join(launcherDir, APP_SERVER_CLIENT_BASENAME),
    );
  }
}

export async function installClaudeHooks(
  options: HookInstallerOptions = {},
): Promise<void> {
  const context = resolveHookInstallerContext(options);
  const configDir = getClaudeDir(context.homeDir);
  if (!(await directoryExists(configDir))) {
    return;
  }

  const settingsPath = path.join(configDir, "settings.json");
  const existingResult = await readJsonObjectFile(settingsPath);
  if (existingResult.status === "invalid") {
    return;
  }

  const existing =
    existingResult.status === "valid" ? existingResult.value : {};
  await backupFile(settingsPath);

  const hooks = toHookArrayMap(existing.hooks);
  for (const event of CLAUDE_EVENTS) {
    hooks[event] = mergeJsonHookEntry({
      existing: toUnknownArray(hooks[event]),
      command: `${launcherCommand(context)} --source claude`,
      timeout: event === "PermissionRequest" ? 86400 : 10,
    });
  }

  existing.hooks = hooks;
  await writeJsonFile(settingsPath, existing);
}

export async function installCodexHooks(
  options: HookInstallerOptions = {},
): Promise<void> {
  const context = resolveHookInstallerContext(options);
  const configDir = getCodexDir(context.homeDir);
  if (!(await directoryExists(configDir))) {
    return;
  }

  const hooksPath = path.join(configDir, "hooks.json");
  const existingResult = await readJsonObjectFile(hooksPath);
  if (existingResult.status === "invalid") {
    return;
  }

  const existing =
    existingResult.status === "valid" ? existingResult.value : {};

  const hooks = toHookArrayMap(existing.hooks);
  let changed = false;
  for (const event of Object.keys(hooks)) {
    const currentEntries = toUnknownArray(hooks[event]);
    const nextEntries = pruneSupersededCodexHooks(
      pruneManagedCodexHooks(currentEntries),
      context.homeDir,
    );
    hooks[event] = nextEntries;
    if (JSON.stringify(nextEntries) !== JSON.stringify(currentEntries)) {
      changed = true;
    }
  }

  if (changed) {
    await backupFile(hooksPath);
    existing.hooks = hooks;
    await writeJsonFile(hooksPath, existing);
  }

  // Strip the legacy top-level `notify = [...]` from ~/.codex/config.toml
  // when it points at our own ~/.codex/notify.sh shim. Without this the
  // bridge launcher (osascript + afplay) and notify.sh fire in parallel,
  // producing duplicated desktop notifications + sounds for every codex Stop.
  await pruneCodexConfigNotify(context);
}

function pruneManagedCodexHooks(entries: Array<unknown>): Array<unknown> {
  const result: Array<unknown> = [];
  for (const entry of entries) {
    if (!isRecord(entry)) {
      result.push(entry);
      continue;
    }

    const prunedEntry = removeRunweaveHooks(entry);
    if (prunedEntry) {
      result.push(prunedEntry);
    }
  }
  return result;
}

export async function pruneCodexConfigNotify(
  options: HookInstallerOptions = {},
): Promise<void> {
  const context = resolveHookInstallerContext(options);
  const configPath = path.join(getCodexDir(context.homeDir), "config.toml");
  const current = await readTextFile(configPath);
  if (!current) {
    return;
  }

  const next = stripLegacyCodexNotifyKey(current);
  if (next === current) {
    return;
  }

  await backupFile(configPath);
  await writeFile(configPath, next, "utf8");
}

export async function installTraeHooks(
  options: HookInstallerOptions = {},
): Promise<void> {
  const context = resolveHookInstallerContext(options);
  const configDir = getTraeDir(context.homeDir);
  if (!(await directoryExists(configDir))) {
    return;
  }

  const tomlPath = path.join(configDir, "traecli.toml");
  const current = await readTextFile(tomlPath);
  const nextContent = cleanupTraeTomlHookBlock(current);
  if (nextContent === current) {
    return;
  }

  await backupFile(tomlPath);
  await writeFile(
    tomlPath,
    nextContent ? ensureTrailingNewline(nextContent) : "",
    "utf8",
  );
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    await access(dirPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function backupFile(filePath: string): Promise<void> {
  try {
    await access(filePath, fsConstants.F_OK);
  } catch {
    return;
  }

  const backupPath = `${filePath}${BACKUP_SUFFIX}`;
  try {
    await access(backupPath, fsConstants.F_OK);
    return;
  } catch {
    // Create the first backup only.
  }

  await copyFile(filePath, `${filePath}${BACKUP_SUFFIX}`);
}

async function readJsonObjectFile(filePath: string): Promise<JsonReadResult> {
  try {
    const content = await readFile(filePath, "utf8");
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed)) {
      return { status: "invalid" };
    }

    if (
      "hooks" in parsed &&
      parsed.hooks !== undefined &&
      !isRecord(parsed.hooks)
    ) {
      return { status: "invalid" };
    }

    if (isRecord(parsed.hooks)) {
      for (const value of Object.values(parsed.hooks)) {
        if (!Array.isArray(value)) {
          return { status: "invalid" };
        }
      }
    }

    return { status: "valid", value: parsed };
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return { status: "missing" };
    }

    return { status: "invalid" };
  }
}

async function writeJsonFile(
  filePath: string,
  value: JsonRecord,
): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readTextFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return "";
    }

    return "";
  }
}

function resolveHookInstallerContext(
  options: HookInstallerOptions,
): HookInstallerContext {
  return {
    homeDir: options.homeDir ?? os.homedir(),
    resourcesDir: options.resourcesDir ?? getDefaultResourcesDir(),
  };
}

function getDefaultResourcesDir(): string {
  // Packaged/bundled CJS runtime: this module is bundled into dist/main.cjs, so
  // `__dirname` is app.asar/dist and resources live at ../resources.
  if (typeof __dirname !== "undefined") {
    return path.join(__dirname, "..", "resources");
  }
  // ESM dev/test runtime: this source file lives at src/hooks/, so resources
  // live at ../../resources. Callers (main.ts, tests) normally inject an
  // explicit resourcesDir; this default is only a fallback.
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "resources",
  );
}

function getDefaultToolkitHooksDir(): string {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "plugins",
    "toolkit",
    "hooks",
  );
}

async function resolveHookAssetPath(
  context: HookInstallerContext,
  basename: string,
): Promise<string> {
  const packagedAsset = path.join(context.resourcesDir, "hooks", basename);
  if (await fileExists(packagedAsset)) {
    return packagedAsset;
  }

  const toolkitAsset = path.join(getDefaultToolkitHooksDir(), basename);
  if (await fileExists(toolkitAsset)) {
    return toolkitAsset;
  }

  return packagedAsset;
}

async function loadLauncherScript(
  context: HookInstallerContext,
): Promise<string> {
  const source = await resolveHookAssetPath(context, LAUNCHER_SCRIPT_BASENAME);
  if (await fileExists(source)) {
    return ensureTrailingNewline(await readFile(source, "utf8"));
  }

  return `${buildLauncherScript()}\n`;
}

function getNotifyHooksDir(homeDir: string): string {
  return path.join(homeDir, ".runweave", "hooks");
}

function getFeishuScriptPath(homeDir: string): string {
  return path.join(getNotifyHooksDir(homeDir), FEISHU_SCRIPT_BASENAME);
}

function getLauncherDir(homeDir: string): string {
  return path.join(homeDir, ".runweave", "bin");
}

function getLauncherPath(homeDir: string): string {
  return path.join(getLauncherDir(homeDir), BRIDGE_BASENAME);
}

function getClaudeDir(homeDir: string): string {
  return path.join(homeDir, ".claude");
}

function getCodexDir(homeDir: string): string {
  return path.join(homeDir, ".codex");
}

function getTraeDir(homeDir: string): string {
  return path.join(homeDir, ".trae");
}

async function hasAnyConfigDir(
  context: HookInstallerContext,
): Promise<boolean> {
  // Phase 1 supports codex + trae only, so the trigger is whichever of those
  // config dirs exist on the host.
  if (await directoryExists(getCodexDir(context.homeDir))) {
    return true;
  }
  if (await directoryExists(getTraeDir(context.homeDir))) {
    return true;
  }
  return false;
}

function launcherCommand(context: HookInstallerContext): string {
  return getLauncherPath(context.homeDir);
}

function toHookArrayMap(value: unknown): Record<string, Array<unknown>> {
  if (!isRecord(value)) {
    return {};
  }

  const result: Record<string, Array<unknown>> = {};
  for (const [key, raw] of Object.entries(value)) {
    result[key] = toUnknownArray(raw);
  }

  return result;
}

function toUnknownArray(value: unknown): Array<unknown> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function removeRunweaveHooks(
  entry: Record<string, unknown>,
): Record<string, unknown> | null {
  const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
  const remainingHooks = hooks.filter(
    (hook) => !(isRecord(hook) && isRunweaveHookObject(hook)),
  );
  if (remainingHooks.length === 0) {
    return null;
  }

  return {
    ...entry,
    hooks: remainingHooks,
  };
}

function isRunweaveHookObject(hook: Record<string, unknown>): boolean {
  if (hook[RUNWEAVE_HOOK_MARKER] === true) {
    return true;
  }

  const command = hook.command;
  return (
    typeof command === "string" &&
    (command.includes(BRIDGE_BASENAME) ||
      command.includes(LEGACY_BRIDGE_BASENAME))
  );
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
