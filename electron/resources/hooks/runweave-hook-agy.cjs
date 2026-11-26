/* global module, process, require */
/* eslint-disable @typescript-eslint/no-require-imports */
const { spawnSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const observedAt = performance.timeOrigin;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readAgyIdentity() {
  const options = {
    encoding: "utf8",
    timeout: 3000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  };
  const processes = new Map();
  if (process.platform === "win32") {
    const script =
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,@{Name="StartedAt";Expression={if ($_.CreationDate) {([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()} else {0}}} | ConvertTo-Json -Compress';
    const result = spawnSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      options,
    );
    if (result.error || result.status !== 0) return null;
    try {
      const rows = JSON.parse(String(result.stdout).replace(/^\uFEFF/, ""));
      for (const row of Array.isArray(rows) ? rows : [rows]) {
        processes.set(row.ProcessId, {
          parent: row.ParentProcessId,
          command: String(row.Name)
            .toLowerCase()
            .replace(/\.(exe|cmd|bat)$/, ""),
          startedAt: row.StartedAt,
        });
      }
    } catch {
      return null;
    }
  } else {
    const result = spawnSync("ps", ["-axo", "pid=,ppid=,comm="], options);
    if (result.error || result.status !== 0) return null;
    for (const line of String(result.stdout).split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      if (match) {
        processes.set(Number(match[1]), {
          parent: Number(match[2]),
          command: path.basename(match[3]),
        });
      }
    }
  }
  let agyPid = null;
  const visited = new Set();
  let childStartedAt = observedAt;
  for (let pid = process.ppid; pid > 1; ) {
    if (visited.has(pid)) return null;
    visited.add(pid);
    const entry = processes.get(pid);
    if (!entry || (process.platform === "win32" && entry.startedAt > childStartedAt)) {
      if (process.platform === "win32" && agyPid) break;
      return null;
    }
    if (process.platform === "win32") childStartedAt = entry.startedAt;
    if (["agy", "claude", "codex", "trae", "traex", "traecli", "pi"].includes(entry.command)) {
      if (agyPid || entry.command !== "agy") return null;
      agyPid = pid;
    }
    pid = entry.parent;
  }
  if (!agyPid) return null;
  let startedAt = processes.get(agyPid).startedAt;
  if (process.platform !== "win32") {
    const result = spawnSync("ps", ["-p", String(agyPid), "-o", "lstart="], {
      ...options,
      env: { TZ: "UTC", LC_ALL: "C" },
    });
    if (result.error || result.status !== 0) return null;
    startedAt = Date.parse(`${String(result.stdout).trim()} UTC`);
  }
  if (!Number.isFinite(startedAt) || startedAt <= 0 || startedAt > observedAt) {
    return null;
  }
  return { instanceId: `${agyPid}:${startedAt}`, startedAt };
}

function readAgyContext(payload, eventId) {
  const conversationId =
    typeof payload?.conversationId === "string" && payload.conversationId.trim()
      ? payload.conversationId.trim()
      : typeof payload?.conversation_id === "string" && payload.conversation_id.trim()
        ? payload.conversation_id.trim()
        : null;
  if (!conversationId || conversationId.length > 256) return null;
  const identity = readAgyIdentity();
  if (!identity) return null;
  const event = String(payload.hookEventName || payload.hook_event_name || "")
    .toLowerCase()
    .replace(/[_\s-]/g, "");
  const terminationReason =
    typeof payload.terminationReason === "string" && payload.terminationReason.trim()
      ? payload.terminationReason.trim()
      : undefined;
  const modelName =
    typeof payload.modelName === "string" && payload.modelName.trim()
      ? payload.modelName.trim()
      : undefined;
  const transcriptPath =
    typeof payload.transcriptPath === "string" && payload.transcriptPath.trim()
      ? payload.transcriptPath.trim()
      : typeof payload.transcript_path === "string" && payload.transcript_path.trim()
        ? payload.transcript_path.trim()
        : undefined;
  return {
    version: 1,
    ...identity,
    observedAt,
    eventId,
    conversationId,
    event: event || "unknown",
    ...(terminationReason ? { terminationReason } : {}),
    ...(typeof payload.fullyIdle === "boolean" ? { fullyIdle: payload.fullyIdle } : {}),
    ...(modelName ? { modelName } : {}),
    ...(transcriptPath ? { transcriptPath } : {}),
  };
}

function resolveSessionMetaDir(transcriptPath, conversationId) {
  if (typeof transcriptPath !== "string" || !path.isAbsolute(transcriptPath)) {
    return null;
  }
  const normalized = path.normalize(transcriptPath);
  const logsSegment = `${path.sep}.system_generated${path.sep}logs${path.sep}`;
  const idx = normalized.indexOf(logsSegment);
  if (idx > 0) {
    const candidate = normalized.slice(0, idx);
    if (
      path.basename(path.dirname(candidate)) === "brain" &&
      (!conversationId || path.basename(candidate) === conversationId)
    ) {
      return candidate;
    }
  }
  return null;
}

function writeAgySessionMeta(payload) {
  try {
    const conversationId =
      typeof payload?.conversationId === "string" && payload.conversationId.trim()
        ? payload.conversationId.trim()
        : typeof payload?.conversation_id === "string" && payload.conversation_id.trim()
          ? payload.conversation_id.trim()
          : null;
    if (!conversationId || !UUID_PATTERN.test(conversationId)) return false;
    const transcriptPath = payload?.transcriptPath ?? payload?.transcript_path;
    const metaDir = resolveSessionMetaDir(transcriptPath, conversationId);
    if (!metaDir) return false;
    const workspacePaths = Array.isArray(payload?.workspacePaths)
      ? payload.workspacePaths.filter((p) => typeof p === "string" && path.isAbsolute(p))
      : [];
    const cwd =
      typeof payload?.cwd === "string" && path.isAbsolute(payload.cwd)
        ? payload.cwd
        : workspacePaths[0] || null;
    if (!cwd) return false;
    const metaPath = path.join(metaDir, ".runweave-agy-meta.json");
    const tmpPath = `${metaPath}.${crypto.randomUUID()}.tmp`;
    const meta = {
      conversationId,
      cwd,
      workspacePaths: workspacePaths.length > 0 ? workspacePaths : [cwd],
      ...(typeof payload?.modelName === "string" && payload.modelName.trim()
        ? { modelName: payload.modelName.trim() }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(metaDir, { recursive: true });
    fs.writeFileSync(tmpPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, metaPath);
    return true;
  } catch {
    return false;
  }
}

function writeAgyHookStdout(normalizedEvent) {
  if (normalizedEvent === "pretooluse" || normalizedEvent === "pre_tool_use") {
    process.stdout.write('{"decision":"allow"}\n');
    return;
  }
  process.stdout.write("{}\n");
}

function stripAgyPromptTags(text) {
  if (typeof text !== "string") return "";
  const userRequestMatch = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(text);
  const base = userRequestMatch ? userRequestMatch[1] : text;
  return base
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "")
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, "")
    .trim();
}

function isAgyCompletionEligible(payload, normalizedEvent) {
  return (
    Boolean(payload.agy) &&
    normalizedEvent === "stop" &&
    (payload.terminationReason === undefined ||
      payload.terminationReason === "NO_TOOL_CALL") &&
    payload.fullyIdle !== false
  );
}

module.exports = {
  readAgyContext,
  writeAgySessionMeta,
  writeAgyHookStdout,
  stripAgyPromptTags,
  isAgyCompletionEligible,
};
