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

const BRIDGE_BASENAME = "browser-viewer-hook-bridge";
const BACKUP_SUFFIX = ".browser-viewer-hook-backup";
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

const CODEX_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop"];
// trae cli reads `~/.trae/traecli.toml` and uses TOML CamelCase event names.
const TRAE_TOML_EVENTS = [
  "PostToolUse",
  "Stop",
  "SubagentStop",
  "UserPromptSubmit",
] as const;
const RUNWEAVE_TRAE_TOML_FENCE_BEGIN =
  "# >>> runweave-hooks (managed by Browser Viewer) >>>";
const RUNWEAVE_TRAE_TOML_FENCE_END =
  "# <<< runweave-hooks (managed by Browser Viewer) <<<";

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
      if (!inserted) {
        merged.push(rewriteBrowserViewerHooks(entry, nextHook));
        inserted = true;
      } else {
        const prunedEntry = removeBrowserViewerHooks(entry);
        if (prunedEntry) {
          merged.push(prunedEntry);
        }
      }

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

// Exact command paths that early Runweave versions wrote into ~/.codex/hooks.json.
// The launcher now handles desktop/sound/Feishu, so these legacy entries would
// otherwise double-notify. We only remove commands that exactly match these
// known legacy paths (optionally followed by arguments) to avoid deleting a
// user's or third-party tool's own notify.sh / feishu_stop_notify.sh.
const LEGACY_CODEX_NOTIFY_RELATIVE_PATHS = [
  ".codex/hooks/feishu_stop_notify.sh",
  ".codex/notify.sh",
];

export function pruneSupersededCodexHooks(
  entries: Array<unknown>,
  homeDir: string,
): Array<unknown> {
  const legacyCommands = new Set(
    LEGACY_CODEX_NOTIFY_RELATIVE_PATHS.map((relative) =>
      path.join(homeDir, relative),
    ),
  );
  const result: Array<unknown> = [];

  for (const entry of entries) {
    if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
      result.push(entry);
      continue;
    }

    const keptHooks = entry.hooks.filter(
      (hook) => !isLegacyCodexNotifyHook(hook, legacyCommands),
    );
    if (keptHooks.length === entry.hooks.length) {
      result.push(entry);
      continue;
    }

    if (keptHooks.length > 0) {
      result.push({ ...entry, hooks: keptHooks });
    }
  }

  return result;
}

function isLegacyCodexNotifyHook(
  hook: unknown,
  legacyCommands: Set<string>,
): boolean {
  if (!isRecord(hook)) {
    return false;
  }

  const command = hook.command;
  if (typeof command !== "string") {
    return false;
  }

  // The command may carry trailing arguments; match on the executable path only.
  const executable = command.trim().split(/\s+/)[0] ?? "";
  return legacyCommands.has(executable);
}

export function renderTraeTomlHookBlock(command: string): string {
  const hookCommand = `${command} --source trae`;
  // Single-quoted TOML strings are literal — no escaping needed for paths
  // and arguments without single quotes. The bridge path and `--source trae`
  // never contain single quotes, so this is safe.
  const lines: string[] = [RUNWEAVE_TRAE_TOML_FENCE_BEGIN];
  for (const event of TRAE_TOML_EVENTS) {
    lines.push(
      `[[hooks.${event}]]`,
      "",
      `[[hooks.${event}.hooks]]`,
      `command = '${hookCommand}'`,
      'timeout = "unlimited"',
      'type = "command"',
      "",
    );
  }
  lines.push(RUNWEAVE_TRAE_TOML_FENCE_END);
  return lines.join("\n");
}

export function buildLauncherScript(): string {
  return [
    "#!/usr/bin/env node",
    "",
    'const STOP_EVENTS = new Set(["stop", "subagent_stop", "subagentstop"]);',
    'const COMPLETION_REASONS = new Set(["hook_stop", "notify", "ai_process_exit", "manual"]);',
    'const { spawn } = require("node:child_process");',
    'const os = require("node:os");',
    'const fs = require("node:fs");',
    "",
    "function notifyDesktop(source) {",
    '  if (process.platform !== "darwin") {',
    "    return;",
    "  }",
    '  const labels = { claude: "Claude", codex: "Codex", trae: "Trae" };',
    '  const name = labels[source] || "AI";',
    "  try {",
    '    spawn("/usr/bin/osascript", ["-e", `display notification "回来接管终端" with title "${name} 完成了"`], { stdio: "ignore", detached: true }).unref();',
    '    spawn("/usr/bin/afplay", ["/System/Library/Sounds/Glass.aiff"], { stdio: "ignore", detached: true }).unref();',
    "  } catch {",
    "    // Ignore desktop notification failures.",
    "  }",
    "}",
    "",
    "function notifyFeishu(payload, source) {",
    "  const script = `${os.homedir()}/.browser-viewer/hooks/feishu_stop_notify.sh`;",
    "  try {",
    "    if (!fs.existsSync(script)) {",
    "      return;",
    "    }",
    '    const child = spawn(script, [], { stdio: ["pipe", "ignore", "ignore"], detached: true });',
    '    child.on("error", () => {});',
    "    child.stdin.end(JSON.stringify({ ...payload, source }));",
    "    child.unref();",
    "  } catch {",
    "    // Ignore Feishu notification failures.",
    "  }",
    "}",
    "",
    "function readStdin() {",
    "  return new Promise((resolve) => {",
    '    let data = "";',
    '    process.stdin.setEncoding("utf8");',
    '    process.stdin.on("data", (chunk) => {',
    "      data += chunk;",
    "    });",
    '    process.stdin.on("end", () => {',
    "      resolve(data);",
    "    });",
    "    process.stdin.resume();",
    "  });",
    "}",
    "",
    "function parseArgs(argv) {",
    '  const args = { source: "unknown", reason: "hook_stop", commandName: null };',
    "  for (let index = 0; index < argv.length; index += 1) {",
    '    if (argv[index] === "--source" && argv[index + 1]) {',
    "      args.source = argv[index + 1];",
    "      index += 1;",
    '    } else if (argv[index] === "--reason" && argv[index + 1]) {',
    "      args.reason = argv[index + 1];",
    "      index += 1;",
    '    } else if (argv[index] === "--command-name" && argv[index + 1]) {',
    "      args.commandName = argv[index + 1];",
    "      index += 1;",
    "    }",
    "  }",
    "  return args;",
    "}",
    "",
    "function parsePayload(raw) {",
    "  if (!raw.trim()) {",
    "    return {};",
    "  }",
    "",
    "  try {",
    "    const parsed = JSON.parse(raw);",
    '    return parsed && typeof parsed === "object" ? parsed : {};',
    "  } catch {",
    "    return {};",
    "  }",
    "}",
    "",
    "function readHookEvent(payload) {",
    "  return (",
    "    payload.hook_event_name ??",
    "    payload.hookEventName ??",
    "    payload.eventName ??",
    "    payload.event ??",
    '    "Unknown"',
    "  );",
    "}",
    "",
    "function normalizeEventName(raw) {",
    '  return String(raw || "Unknown")',
    "    .trim()",
    "    .toLowerCase()",
    '    .replace(/[-\\s]+/g, "_");',
    "}",
    "",
    "function normalizeSource(raw) {",
    '  const source = String(raw || "unknown").trim().toLowerCase();',
    '  if (source === "claude" || source === "codex" || source === "trae") {',
    "    return source;",
    "  }",
    '  return "unknown";',
    "}",
    "",
    "function normalizeReason(raw) {",
    '  const reason = String(raw || "hook_stop").trim().toLowerCase();',
    '  return COMPLETION_REASONS.has(reason) ? reason : "hook_stop";',
    "}",
    "",
    "function deriveCompletionEndpoint(endpoint) {",
    "  if (!endpoint) {",
    "    return undefined;",
    "  }",
    '  return endpoint.replace(/\\/internal\\/terminal\\/agent-hook\\/?$/, "/internal/terminal-completion");',
    "}",
    "",
    "function toAgentHookStateEvent(normalizedEvent) {",
    '  if (normalizedEvent === "sessionstart" || normalizedEvent === "session_start") {',
    '    return "SessionStart";',
    "  }",
    '  if (normalizedEvent === "userpromptsubmit" || normalizedEvent === "user_prompt_submit") {',
    '    return "UserPromptSubmit";',
    "  }",
    "  if (STOP_EVENTS.has(normalizedEvent)) {",
    '    return "Stop";',
    "  }",
    "  return null;",
    "}",
    "",
    "async function postAgentHook({ endpoint, token, terminalSessionId, hookEvent }) {",
    "  await fetch(endpoint, {",
    '    method: "POST",',
    "    headers: {",
    '      "Content-Type": "application/json",',
    '      "X-Runweave-Hook-Token": token,',
    "    },",
    "    body: JSON.stringify({",
    "      terminalSessionId,",
    "      projectId: process.env.RUNWEAVE_PROJECT_ID || undefined,",
    '      agent: "codex",',
    "      hookEvent,",
    "    }),",
    "  }).catch(() => undefined);",
    "}",
    "",
    "async function postCompletionHook({ endpoint, token, terminalSessionId, payload, source, completionReason, rawEvent, commandName }) {",
    "  await fetch(endpoint, {",
    '    method: "POST",',
    "    headers: {",
    '      "Content-Type": "application/json",',
    '      "X-Runweave-Hook-Token": token,',
    "    },",
    "    body: JSON.stringify({",
    "      terminalSessionId,",
    "      source,",
    "      completionReason,",
    "      commandName: commandName || null,",
    '      rawHookEvent: String(rawEvent || "Stop"),',
    '      hookEvent: String(rawEvent || "Stop"),',
    "      cwd:",
    '        typeof payload.cwd === "string" && payload.cwd.trim()',
    "          ? payload.cwd",
    "          : process.env.PWD || null,",
    "    }),",
    "  }).catch(() => undefined);",
    "}",
    "",
    "async function main() {",
    "  const args = parseArgs(process.argv.slice(2));",
    "  const payload = parsePayload(await readStdin());",
    "  const rawEvent = readHookEvent(payload);",
    "  const normalizedEvent = normalizeEventName(rawEvent);",
    "  const source = normalizeSource(args.source);",
    "  const completionReason = normalizeReason(args.reason);",
    "  const stateHookEvent = source === \"codex\" ? toAgentHookStateEvent(normalizedEvent) : null;",
    '  const shouldRecordCompletion = completionReason !== "hook_stop" || STOP_EVENTS.has(normalizedEvent);',
    "",
    "  const endpoint = process.env.RUNWEAVE_HOOK_ENDPOINT;",
    "  const completionEndpoint =",
    "    process.env.RUNWEAVE_COMPLETION_HOOK_ENDPOINT || deriveCompletionEndpoint(endpoint);",
    "  const token = process.env.RUNWEAVE_HOOK_TOKEN;",
    "  const terminalSessionId = process.env.RUNWEAVE_TERMINAL_SESSION_ID;",
    "  // Only notify / report for completions inside a Runweave terminal. The hook",
    "  // is installed into the user's global Claude/Codex/Trae config, so without",
    "  // this gate every AI CLI stop in any external terminal would trigger desktop",
    "  // and Feishu notifications.",
    "  if (!token || !terminalSessionId) {",
    "    return;",
    "  }",
    "",
    "  if (stateHookEvent && endpoint) {",
    "    await postAgentHook({ endpoint, token, terminalSessionId, hookEvent: stateHookEvent });",
    "  }",
    "",
    "  if (shouldRecordCompletion && completionEndpoint) {",
    "    notifyDesktop(source);",
    "    notifyFeishu(payload, source);",
    "    await postCompletionHook({",
    "      endpoint: completionEndpoint,",
    "      token,",
    "      terminalSessionId,",
    "      payload,",
    "      source,",
    "      completionReason,",
    "      rawEvent,",
    "      commandName: args.commandName,",
    "    });",
    "  }",
    "}",
    "",
    "main().catch(() => {",
    "  process.exitCode = 0;",
    "});",
    "",
  ].join("\n");
}

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
  const source = path.join(
    context.resourcesDir,
    "hooks",
    FEISHU_SCRIPT_BASENAME,
  );
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

  await mkdir(launcherDir, { recursive: true });
  await writeFile(launcherPath, buildLauncherScript(), "utf8");
  await chmod(launcherPath, 0o755);
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
  await backupFile(hooksPath);

  const hooks = toHookArrayMap(existing.hooks);
  for (const event of CODEX_EVENTS) {
    hooks[event] = mergeJsonHookEntry({
      existing: toUnknownArray(hooks[event]),
      command: `${launcherCommand(context)} --source codex`,
      timeout: 5,
    });
  }

  // Remove superseded codex notify entries that the launcher now handles,
  // so desktop notification / sound / Feishu are not sent twice.
  for (const event of Object.keys(hooks)) {
    hooks[event] = pruneSupersededCodexHooks(
      toUnknownArray(hooks[event]),
      context.homeDir,
    );
  }

  existing.hooks = hooks;
  await writeJsonFile(hooksPath, existing);

  // Strip the legacy top-level `notify = [...]` from ~/.codex/config.toml
  // when it points at our own ~/.codex/notify.sh shim. Without this the
  // bridge launcher (osascript + afplay) and notify.sh fire in parallel,
  // producing duplicated desktop notifications + sounds for every codex Stop.
  await pruneCodexConfigNotify(context);
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

// Remove a top-level `notify = [...]` key from ~/.codex/config.toml when its
// value references our legacy ~/.codex/notify.sh shim (directly, or via the
// SkyComputerUseClient `--previous-notify` wrapper). Sections like
// `[some.table]\nnotify = [...]` are left untouched, and unrelated notify
// configurations (third-party, not pointing at notify.sh) are kept as-is.
export function stripLegacyCodexNotifyKey(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let insideSection = false;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (/^\[\[?[^\]]+\]?\]/.test(trimmed)) {
      insideSection = true;
      result.push(line);
      index += 1;
      continue;
    }

    if (!insideSection && /^notify\s*=\s*\[/.test(line)) {
      const arrayEnd = findTomlArrayEnd(lines, index);
      if (arrayEnd !== -1) {
        const captured = lines.slice(index, arrayEnd + 1).join("\n");
        if (captured.includes("notify.sh")) {
          index = arrayEnd + 1;
          continue;
        }
      }
    }

    result.push(line);
    index += 1;
  }

  return result.join("\n");
}

function findTomlArrayEnd(lines: string[], startIndex: number): number {
  let depth = 0;
  let inString: '"' | "'" | null = null;
  for (let lineIndex = startIndex; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    for (let charIndex = 0; charIndex < line.length; charIndex += 1) {
      const ch = line[charIndex];
      if (inString) {
        if (ch === "\\" && inString === '"') {
          charIndex += 1;
          continue;
        }
        if (ch === inString) {
          inString = null;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = ch;
        continue;
      }
      if (ch === "[") {
        depth += 1;
      } else if (ch === "]") {
        depth -= 1;
        if (depth === 0) {
          return lineIndex;
        }
      }
    }
  }
  return -1;
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
  await backupFile(tomlPath);

  const current = await readTextFile(tomlPath);
  const nextBlock = renderTraeTomlHookBlock(launcherCommand(context));
  const nextContent = upsertTraeTomlHookBlock(current, nextBlock);

  await writeFile(tomlPath, ensureTrailingNewline(nextContent), "utf8");
}

export function upsertTraeTomlHookBlock(
  content: string,
  block: string,
): string {
  const fenceRegex = new RegExp(
    `${escapeRegex(RUNWEAVE_TRAE_TOML_FENCE_BEGIN)}[\\s\\S]*?${escapeRegex(
      RUNWEAVE_TRAE_TOML_FENCE_END,
    )}`,
    "g",
  );

  const fenceMatch = fenceRegex.exec(content);
  if (fenceMatch) {
    const before = stripLegacyTraeBridgeEntries(
      content.slice(0, fenceMatch.index),
    );
    const after = stripLegacyTraeBridgeEntries(
      content.slice(fenceMatch.index + fenceMatch[0].length),
    );
    return collapseBlankLines(`${before}${block}${after}`);
  }

  const stripped = stripLegacyTraeBridgeEntries(content);
  if (!stripped.trim()) {
    return block;
  }
  return collapseBlankLines(`${stripped.trimEnd()}\n\n${block}`);
}

// Strip any pre-existing un-fenced [[hooks.<Event>]] paragraphs that point at
// the Runweave bridge so we can replace them with the fenced canonical block.
// Earlier installer revisions wrote individual entries without fence markers,
// and some users edited traecli.toml by hand — both leave un-fenced entries.
function stripLegacyTraeBridgeEntries(content: string): string {
  // Match a top-level [[hooks.<Event>]] paragraph followed by its
  // [[hooks.<Event>.hooks]] sub-table whose command references the bridge.
  // The body runs up to the next TOML section header (line starting with `[`).
  const legacyRegex =
    /\[\[hooks\.[A-Za-z][A-Za-z0-9_]*\]\][^[]*\[\[hooks\.[A-Za-z][A-Za-z0-9_]*\.hooks\]\][^[]*?browser-viewer-hook-bridge[^[]*/g;
  return content.replace(legacyRegex, "");
}

function collapseBlankLines(content: string): string {
  return content.replace(/\n{3,}/g, "\n\n");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function getNotifyHooksDir(homeDir: string): string {
  return path.join(homeDir, ".browser-viewer", "hooks");
}

function getFeishuScriptPath(homeDir: string): string {
  return path.join(getNotifyHooksDir(homeDir), FEISHU_SCRIPT_BASENAME);
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
    // Stable marker identifying entries Runweave owns, so future migrations can
    // safely clean up only our own hooks instead of matching on command strings.
    [RUNWEAVE_HOOK_MARKER]: true,
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

function removeBrowserViewerHooks(
  entry: Record<string, unknown>,
): Record<string, unknown> | null {
  const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
  const remainingHooks = hooks.filter(
    (hook) => !(isRecord(hook) && isBrowserViewerHookObject(hook)),
  );
  if (remainingHooks.length === 0) {
    return null;
  }

  return {
    ...entry,
    hooks: remainingHooks,
  };
}

function isBrowserViewerHookObject(hook: Record<string, unknown>): boolean {
  const command = hook.command;
  return typeof command === "string" && command.includes(BRIDGE_BASENAME);
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
