import { resolveClaudeConfiguration } from "@runweave/config-node/claude";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { getAgentForCommand } from "../state/terminal-state-service";
import type { TerminalPanelRecord, TerminalSessionRecord } from "../manager/records";
import type { TmuxService } from "../tmux/service";
import { resolveTmuxTarget } from "./launcher";

const SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Native identity for reading only. Never establishes input readiness or lifecycle state. */
export async function readClaudeConversationIdentity(
  session: TerminalSessionRecord, panel: TerminalPanelRecord, tmux: TmuxService,
): Promise<{ threadId: string; pid: number; processStart: string } | null> {
  if (session.status !== "running" || panel.status !== "running" || session.runtimeKind !== "tmux") return null;
  const pane = { ...resolveTmuxTarget(session, tmux), paneId: panel.tmuxPaneId };
  const panePid = await tmux.readPaneProcessId(pane);
  if (!Number.isSafeInteger(panePid) || panePid <= 0) return null;
  const psOptions = { env: { ...process.env, TZ: "UTC", LC_ALL: "C" }, timeout: 2_000, maxBuffer: 4 * 1024 * 1024 };
  const { stdout } = await tmux.execFileImpl("ps", ["-axo", "pid=,ppid=,comm="], psOptions);
  const processes = new Map<number, { parent: number; agent: string | null }>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match) processes.set(Number(match[1]), { parent: Number(match[2]), agent: getAgentForCommand(match[3]!) });
  }
  const candidates = [...processes].filter(([pid, info]) => {
    if (info.agent !== "claude") return false;
    if (pid === panePid) return true;
    if (processes.get(panePid)?.agent) return false;
    const visited = new Set<number>([pid]);
    let parent = info.parent;
    while (parent !== panePid) {
      if (visited.has(parent)) return false;
      visited.add(parent);
      const ancestor = processes.get(parent);
      // A Claude child of another Agent is not the pane's primary conversation.
      if (!ancestor || ancestor.agent) return false;
      parent = ancestor.parent;
    }
    return true;
  });
  if (candidates.length !== 1) return null;
  const [pid, processInfo] = candidates[0]!;
  const file = path.join(resolveClaudeConfiguration().configDirectory, "sessions", `${pid}.json`);
  try {
    if (await realpath(file) !== file) return null;
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let native: Record<string, unknown>;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16_384) return null;
      const bytes = Buffer.alloc(16_385);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 16_384) return null;
      native = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    } finally { await handle.close(); }
    if (!native || native.pid !== pid || native.pidDomain !== process.platform || native.kind !== "interactive" ||
        typeof native.sessionId !== "string" || !SESSION_ID.test(native.sessionId) ||
        typeof native.cwd !== "string" || !path.isAbsolute(native.cwd) || path.resolve(native.cwd) !== path.resolve(panel.cwd) ||
        typeof native.procStart !== "string") return null;
    // UTC process birth time rejects stale native registrations after PID reuse.
    const current = await tmux.execFileImpl("ps", ["-p", String(pid), "-o", "ppid=,lstart="], psOptions);
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(current.stdout);
    if (!match || Number(match[1]) !== processInfo.parent || normalize(match[2]!) !== normalize(native.procStart)) return null;
    return { threadId: native.sessionId, pid, processStart: normalize(native.procStart) };
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes(String((error as NodeJS.ErrnoException).code))) return null;
    throw error;
  }
}

function normalize(value: string): string { return value.trim().replace(/\s+/g, " "); }
