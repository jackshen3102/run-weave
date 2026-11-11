/* global module, process, require */
/* eslint-disable @typescript-eslint/no-require-imports */
const { spawnSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const path = require("node:path");

// Use process birth, before stdin/network work, so delayed delivery cannot roll state back.
const observedAt = performance.timeOrigin;

function readClaudeIdentity() {
  const options = { encoding: "utf8", timeout: 3000, maxBuffer: 4 * 1024 * 1024, windowsHide: true };
  const processes = new Map();
  if (process.platform === "win32") {
    const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,@{Name="StartedAt";Expression={if ($_.CreationDate) {([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()} else {0}}} | ConvertTo-Json -Compress';
    const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], options);
    if (result.error || result.status !== 0) return null;
    try {
      const rows = JSON.parse(String(result.stdout).replace(/^\uFEFF/, ""));
      for (const row of Array.isArray(rows) ? rows : [rows]) {
        processes.set(row.ProcessId, { parent: row.ParentProcessId,
          command: String(row.Name).toLowerCase().replace(/\.(exe|cmd|bat)$/, ""), startedAt: row.StartedAt });
      }
    } catch { return null; }
  } else {
    const result = spawnSync("ps", ["-axo", "pid=,ppid=,comm="], options);
    if (result.error || result.status !== 0) return null;
    for (const line of String(result.stdout).split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      if (match) processes.set(Number(match[1]), { parent: Number(match[2]), command: path.basename(match[3]) });
    }
  }
  let claudePid = null;
  const visited = new Set();
  for (let pid = process.ppid; pid > 1; ) {
    if (visited.has(pid)) return null;
    visited.add(pid);
    const entry = processes.get(pid);
    if (!entry) return null;
    if (["claude", "codex", "trae", "traex", "traecli", "pi"].includes(entry.command)) {
      if (claudePid || entry.command !== "claude") return null;
      claudePid = pid;
    }
    pid = entry.parent;
  }
  if (!claudePid) return null;
  let startedAt = processes.get(claudePid).startedAt;
  if (process.platform !== "win32") {
    const result = spawnSync("ps", ["-p", String(claudePid), "-o", "lstart="], {
      ...options, env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
    });
    if (result.error || result.status !== 0) return null;
    startedAt = Date.parse(`${String(result.stdout).trim()} UTC`);
  }
  if (!Number.isFinite(startedAt) || startedAt <= 0 || startedAt > observedAt) return null;
  return { instanceId: `${claudePid}:${startedAt}`, startedAt };
}

function readClaudeContext(payload, eventId) {
  if (payload.agent_id || payload.agent_transcript_path || !payload.session_id) return null;
  const identity = readClaudeIdentity();
  if (!identity) return null;
  return { version: 1, ...identity, observedAt, eventId, sessionId: payload.session_id,
    event: String(payload.hook_event_name || "").toLowerCase().replace(/[_\s-]/g, ""),
    ...(payload.source ? { sessionSource: payload.source } : {}),
    ...(payload.notification_type ? { notificationType: payload.notification_type } : {}) };
}

module.exports = { readClaudeContext };
