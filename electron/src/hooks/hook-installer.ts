import { access, chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { constants as fsConstants } from "node:fs";

type JsonRecord = Record<string, unknown>;

const BRIDGE_BASENAME = "browser-viewer-hook-bridge";
const BACKUP_SUFFIX = ".browser-viewer-hook-backup";
const LAUNCHER_DIR = path.join(os.homedir(), ".browser-viewer", "bin");
const LAUNCHER_PATH = path.join(LAUNCHER_DIR, BRIDGE_BASENAME);

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
  existing: Array<Record<string, unknown>>;
  command: string;
  timeout: number;
}): Array<Record<string, unknown>> {
  const nextHook: JsonRecord = {
    type: "command",
    command: args.command,
    timeout: args.timeout,
  };

  const merged: Array<Record<string, unknown>> = [];
  let inserted = false;

  for (const entry of args.existing) {
    if (isBrowserViewerHookEntry(entry)) {
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
    `LAUNCHER_NAME="${BRIDGE_BASENAME}"`,
    `exec node "${packagedBridgePath}" "$@"`,
    "",
  ].join("\n");
}

export async function installHooksIfNeeded(): Promise<void> {
  await installAllHooks();
}

export async function installAllHooks(): Promise<void> {
  await writeLauncherScript();
  await installClaudeHooks();
  await installCodexHooks();
  await installTraeHooks();
}

export async function writeLauncherScript(packagedBridgePath = resolvePackagedBridgePath()): Promise<void> {
  await mkdir(LAUNCHER_DIR, { recursive: true });
  await writeFile(LAUNCHER_PATH, buildLauncherScript({ packagedBridgePath }), "utf8");
  await chmod(LAUNCHER_PATH, 0o755);
}

export async function installClaudeHooks(): Promise<void> {
  const configDir = path.join(os.homedir(), ".claude");
  if (!(await directoryExists(configDir))) {
    return;
  }

  const settingsPath = path.join(configDir, "settings.json");
  const existing = (await readJsonFile(settingsPath)) ?? {};
  await backupFile(settingsPath);

  const hooks = toRecordMap(existing.hooks);
  for (const event of CLAUDE_EVENTS) {
    hooks[event] = mergeJsonHookEntry({
      existing: toEntryArray(hooks[event]),
      command: `${launcherCommand()} --source claude`,
      timeout: event === "PermissionRequest" ? 86400 : 10,
    });
  }

  existing.hooks = hooks;
  await writeJsonFile(settingsPath, existing);
}

export async function installCodexHooks(): Promise<void> {
  const configDir = path.join(os.homedir(), ".codex");
  if (!(await directoryExists(configDir))) {
    return;
  }

  const hooksPath = path.join(configDir, "hooks.json");
  const existing = (await readJsonFile(hooksPath)) ?? {};
  await backupFile(hooksPath);

  const hooks = toRecordMap(existing.hooks);
  for (const event of CODEX_EVENTS) {
    hooks[event] = mergeJsonHookEntry({
      existing: toEntryArray(hooks[event]),
      command: `${launcherCommand()} --source codex`,
      timeout: 5,
    });
  }

  existing.hooks = hooks;
  await writeJsonFile(hooksPath, existing);
}

export async function installTraeHooks(): Promise<void> {
  const configDir = path.join(os.homedir(), ".trae");
  if (!(await directoryExists(configDir))) {
    return;
  }

  const yamlPath = path.join(configDir, "traecli.yaml");
  await backupFile(yamlPath);

  const current = await readTextFile(yamlPath);
  const nextBlock = renderTraeHookBlock(launcherCommand());
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

  await copyFile(filePath, `${filePath}${BACKUP_SUFFIX}`);
}

async function readJsonFile(filePath: string): Promise<JsonRecord | null> {
  try {
    const content = await readFile(filePath, "utf8");
    const parsed = JSON.parse(content) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readTextFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function writeJsonFile(filePath: string, value: JsonRecord): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function launcherCommand(): string {
  return LAUNCHER_PATH;
}

function resolvePackagedBridgePath(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return path.join(resourcesPath ?? process.cwd(), "hook-bridge.mjs");
}

function toRecordMap(value: unknown): Record<string, Array<Record<string, unknown>>> {
  if (!isRecord(value)) {
    return {};
  }

  const result: Record<string, Array<Record<string, unknown>>> = {};
  for (const [key, raw] of Object.entries(value)) {
    result[key] = toEntryArray(raw);
  }

  return result;
}

function toEntryArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isRecord);
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

function rewriteBrowserViewerHooks(
  entry: Record<string, unknown>,
  nextHook: Record<string, unknown>,
): Record<string, unknown> {
  const hooks = Array.isArray(entry.hooks) ? entry.hooks.filter(isRecord) : [];
  const rewrittenHooks = hooks.map((hook) =>
    isBrowserViewerHookObject(hook) ? { ...nextHook } : hook,
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
  const browserViewerLocation = findTraeBrowserViewerBlock(lines);

  if (browserViewerLocation) {
    const nextLines = [
      ...lines.slice(0, browserViewerLocation.start),
      ...blockLines,
      ...lines.slice(browserViewerLocation.end),
    ];
    return joinYamlLines(nextLines);
  }

  const hooksSection = findTopLevelHooksSection(lines);
  if (hooksSection) {
    const nextLines = [
      ...lines.slice(0, hooksSection.end),
      ...blockLines,
      ...lines.slice(hooksSection.end),
    ];
    return joinYamlLines(nextLines);
  }

  return `${content.trimEnd()}\n\nhooks:\n${block}`;
}

function findTraeBrowserViewerBlock(lines: string[]): { start: number; end: number } | null {
  const commandLineIndex = lines.findIndex((line) => line.includes(BRIDGE_BASENAME));
  if (commandLineIndex < 0) {
    return null;
  }

  const start = findTraeBlockStart(lines, commandLineIndex);
  const end = findTraeBlockEnd(lines, start);
  return { start, end };
}

function findTraeBlockStart(lines: string[], index: number): number {
  for (let current = index; current >= 0; current -= 1) {
    const line = lines[current] ?? "";
    if (line.trim().startsWith("- type: command")) {
      return current;
    }
  }

  return index;
}

function findTraeBlockEnd(lines: string[], start: number): number {
  const startIndent = lineIndent(lines[start] ?? "");
  let current = start + 1;

  while (current < lines.length) {
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
