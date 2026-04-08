import { access, chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { constants as fsConstants } from "node:fs";

type JsonRecord = Record<string, unknown>;
type HookInstallerOptions = {
  homeDir?: string;
  resourcesPath?: string | null;
};

type HookInstallerContext = {
  homeDir: string;
  resourcesPath: string | null;
};

type JsonReadResult =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "valid"; value: JsonRecord };

const BRIDGE_BASENAME = "browser-viewer-hook-bridge";
const BACKUP_SUFFIX = ".browser-viewer-hook-backup";

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

const CODEX_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop"];
const TRAE_EVENTS = ["user_prompt_submit", "post_tool_use", "stop", "subagent_stop"];

export function mergeJsonHookEntry(args: {
  existing: Array<unknown>;
  command: string;
  timeout: number;
}): Array<unknown> {
  const nextHook = createBrowserViewerHook(args.command, args.timeout);

  const merged: Array<unknown> = [];
  let inserted = false;

  for (const entry of args.existing) {
    if (isRecord(entry) && isBrowserViewerHookEntry(entry)) {
      merged.push(rewriteBrowserViewerHooks(entry, nextHook));
      inserted = true;
      continue;
    }

    merged.push(entry);
  }

  if (!inserted) {
    merged.push({
      matcher: "*",
      hooks: [nextHook],
    });
  }

  return merged;
}

export function renderTraeHookBlock(command: string): string {
  const hookCommand = `${command} --source trae`;
  const quotedCommand = hookCommand.replace(/'/g, "''");

  return [
    "  - type: command",
    `    command: '${quotedCommand}'`,
    "    matchers:",
    ...TRAE_EVENTS.map((event) => `      - event: ${event}`),
  ].join("\n");
}

export function buildLauncherScript(args: {
  packagedBridgePath: string;
}): string {
  const packagedBridgePath = args.packagedBridgePath.replace(/"/g, '\\"');

  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `HOOK_BRIDGE_PATH="${packagedBridgePath}"`,
    'if [ -x "$HOOK_BRIDGE_PATH" ]; then',
    '  exec "$HOOK_BRIDGE_PATH" "$@"',
    "fi",
    'exec node "$HOOK_BRIDGE_PATH" "$@"',
    "",
  ].join("\n");
}

export async function installHooksIfNeeded(options: HookInstallerOptions = {}): Promise<void> {
  const context = resolveHookInstallerContext(options);
  if (!(await hasAnyConfigDir(context))) {
    return;
  }

  await installAllHooks(context);
}

export async function installAllHooks(options: HookInstallerOptions = {}): Promise<void> {
  const context = resolveHookInstallerContext(options);
  await writeLauncherScript(context);
  await installClaudeHooks(context);
  await installCodexHooks(context);
  await installTraeHooks(context);
}

export async function writeLauncherScript(options: HookInstallerOptions = {}): Promise<void> {
  const context = resolveHookInstallerContext(options);
  const launcherDir = getLauncherDir(context.homeDir);
  const launcherPath = getLauncherPath(context.homeDir);

  await mkdir(launcherDir, { recursive: true });
  await writeFile(
    launcherPath,
    buildLauncherScript({ packagedBridgePath: resolvePackagedBridgePath(context) }),
    "utf8",
  );
  await chmod(launcherPath, 0o755);
}

export async function installClaudeHooks(options: HookInstallerOptions = {}): Promise<void> {
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

  const existing = existingResult.status === "valid" ? existingResult.value : {};
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

export async function installCodexHooks(options: HookInstallerOptions = {}): Promise<void> {
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

  const existing = existingResult.status === "valid" ? existingResult.value : {};
  await backupFile(hooksPath);

  const hooks = toHookArrayMap(existing.hooks);
  for (const event of CODEX_EVENTS) {
    hooks[event] = mergeJsonHookEntry({
      existing: toUnknownArray(hooks[event]),
      command: `${launcherCommand(context)} --source codex`,
      timeout: 5,
    });
  }

  existing.hooks = hooks;
  await writeJsonFile(hooksPath, existing);
}

export async function installTraeHooks(options: HookInstallerOptions = {}): Promise<void> {
  const context = resolveHookInstallerContext(options);
  const configDir = getTraeDir(context.homeDir);
  if (!(await directoryExists(configDir))) {
    return;
  }

  const yamlPath = path.join(configDir, "traecli.yaml");
  await backupFile(yamlPath);

  const current = await readTextFile(yamlPath);
  const nextBlock = renderTraeHookBlock(launcherCommand(context));
  const nextContent = upsertTraeHookBlock(current, nextBlock);

  await writeFile(yamlPath, ensureTrailingNewline(nextContent), "utf8");
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    await access(dirPath, fsConstants.F_OK);
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

    if ("hooks" in parsed && parsed.hooks !== undefined && !isRecord(parsed.hooks)) {
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

async function writeJsonFile(filePath: string, value: JsonRecord): Promise<void> {
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

function resolveHookInstallerContext(options: HookInstallerOptions): HookInstallerContext {
  return {
    homeDir: options.homeDir ?? os.homedir(),
    resourcesPath: options.resourcesPath ?? getProcessResourcesPath(),
  };
}

function getProcessResourcesPath(): string | null {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return typeof resourcesPath === "string" && resourcesPath ? resourcesPath : null;
}

function getLauncherDir(homeDir: string): string {
  return path.join(homeDir, ".browser-viewer", "bin");
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

async function hasAnyConfigDir(context: HookInstallerContext): Promise<boolean> {
  return (
    (await directoryExists(getClaudeDir(context.homeDir))) ||
    (await directoryExists(getCodexDir(context.homeDir))) ||
    (await directoryExists(getTraeDir(context.homeDir)))
  );
}

function launcherCommand(context: HookInstallerContext): string {
  return getLauncherPath(context.homeDir);
}

function resolvePackagedBridgePath(context: HookInstallerContext): string {
  return path.join(context.resourcesPath ?? process.cwd(), "hook-bridge.mjs");
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

function isBrowserViewerHookEntry(entry: Record<string, unknown>): boolean {
  const hooks = entry.hooks;
  if (!Array.isArray(hooks)) {
    return false;
  }

  return hooks.some((hook) => {
    if (!isRecord(hook)) {
      return false;
    }

    const command = hook.command;
    return typeof command === "string" && command.includes(BRIDGE_BASENAME);
  });
}

function createBrowserViewerHook(command: string, timeout: number): JsonRecord {
  return {
    type: "command",
    command,
    timeout,
  };
}

function rewriteBrowserViewerHooks(
  entry: Record<string, unknown>,
  nextHook: Record<string, unknown>,
): Record<string, unknown> {
  const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
  const rewrittenHooks = hooks.map((hook) =>
    isRecord(hook) && isBrowserViewerHookObject(hook) ? { ...nextHook } : hook,
  );

  return {
    ...entry,
    hooks: rewrittenHooks,
  };
}

function isBrowserViewerHookObject(hook: Record<string, unknown>): boolean {
  const command = hook.command;
  return typeof command === "string" && command.includes(BRIDGE_BASENAME);
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

export function upsertTraeHookBlock(content: string, block: string): string {
  if (!content.trim()) {
    return `hooks:\n${block}`;
  }

  const lines = content.split("\n");
  const blockLines = block.split("\n");
  const hooksSection = findTopLevelHooksSection(lines);
  if (hooksSection) {
    const browserViewerLocation = findTraeBrowserViewerBlock(
      lines,
      hooksSection.start + 1,
      hooksSection.end,
    );
    const insertAt = browserViewerLocation ? browserViewerLocation.start : hooksSection.end;
    const removeEnd = browserViewerLocation ? browserViewerLocation.end : hooksSection.end;
    const nextLines = [...lines.slice(0, insertAt), ...blockLines, ...lines.slice(removeEnd)];
    return joinYamlLines(nextLines);
  }

  return `${content.trimEnd()}\n\nhooks:\n${block}`;
}

function findTraeBrowserViewerBlock(
  lines: string[],
  startIndex: number,
  endIndex: number,
): { start: number; end: number } | null {
  const commandLineIndex = lines.findIndex(
    (line, index) => index >= startIndex && index < endIndex && line.includes(BRIDGE_BASENAME),
  );
  if (commandLineIndex < 0) {
    return null;
  }

  const start = findTraeBlockStart(lines, commandLineIndex, startIndex);
  const end = findTraeBlockEnd(lines, start, endIndex);
  return { start, end };
}

function findTraeBlockStart(lines: string[], index: number, floor: number): number {
  for (let current = index; current >= floor; current -= 1) {
    const line = lines[current] ?? "";
    if (line.trim().startsWith("- type: command")) {
      return current;
    }
  }

  return floor;
}

function findTraeBlockEnd(lines: string[], start: number, ceiling: number): number {
  const startIndent = lineIndent(lines[start] ?? "");
  let current = start + 1;

  while (current < lines.length && current < ceiling) {
    const line = lines[current] ?? "";
    const trimmed = line.trim();
    const indent = lineIndent(line);
    if (trimmed !== "" && indent <= startIndent) {
      break;
    }

    current += 1;
  }

  return current;
}

function findTopLevelHooksSection(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex((line) => line.trim() === "hooks:" && lineIndent(line) === 0);
  if (start < 0) {
    return null;
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      continue;
    }

    if (lineIndent(line) === 0) {
      end = index;
      break;
    }
  }

  return { start, end };
}

function joinYamlLines(lines: string[]): string {
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

function lineIndent(line: string): number {
  const match = line.match(/^(\s*)/);
  return match?.[1]?.length ?? 0;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
