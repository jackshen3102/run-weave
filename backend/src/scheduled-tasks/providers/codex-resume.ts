import type { ScheduledTaskConfig } from "@runweave/shared/scheduled-tasks";
import { execFile } from "node:child_process";
import { open, readdir, readFile, readlink, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { readCodexProcessArguments } from "../../terminal/attachments/codex-execution";
import { readCodexContext } from "../../terminal/runtime/codex-context";
import type { TerminalPanelRecord } from "../../terminal/manager/manager";
import { codexAppServerClient } from "../../voice/codex-app-server-client";
import { ScheduledTaskError } from "../errors";
import { codexScheduledArgs } from "./codex-options";

const exec = promisify(execFile);

interface ResumeCheckpoint {
  path: string;
  inode: number;
  device: number;
}

export async function checkpointCodexResume(
  threadId: string,
  cwd: string,
): Promise<ResumeCheckpoint> {
  try {
    const result = (await codexAppServerClient.sendRequest("thread/read", {
      threadId,
      includeTurns: false,
    })) as { thread?: { id?: string; path?: string; cwd?: string } };
    const thread = result.thread;
    if (thread?.id !== threadId || thread.cwd !== cwd || !thread.path)
      throw new Error("thread_identity_unavailable");
    const file = await open(thread.path, "r");
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new Error("thread_history_unavailable");
      return {
        path: thread.path,
        inode: info.ino,
        device: info.dev,
      };
    } finally {
      await file.close();
    }
  } catch {
    throw new ScheduledTaskError(
      "thread_unavailable",
      409,
      "The original Codex thread history is unavailable",
    );
  }
}

// An idle resume need not append any rollout event. Confirm the owning TUI,
// not historical settings or screen text. Managed observations also own readiness.
export async function confirmCodexResume(
  checkpoint: ResumeCheckpoint,
  threadId: string,
  cwd: string,
  config: Pick<ScheduledTaskConfig, "model" | "effort" | "executionPolicy">,
  owner: { panePid: number; panel: TerminalPanelRecord; operationId: string },
): Promise<"agent_idle" | "agent_running" | null> {
  try {
    const info = await stat(checkpoint.path);
    if (info.ino !== checkpoint.inode || info.dev !== checkpoint.device)
      return null;
    const { stdout: group } = await exec(
      "ps",
      ["-p", String(owner.panePid), "-o", "tpgid="],
      { timeout: 3000 },
    );
    const foreground = Number(group.trim());
    if (!Number.isSafeInteger(foreground) || foreground <= 0) return null;
    const { stdout } = await exec("ps", ["-axo", "pid=,pgid="], {
      timeout: 3000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const pids = stdout.split("\n").flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
      return match && Number(match[2]) === foreground ? [Number(match[1])] : [];
    });
    const observed = readCodexContext(owner.panel);
    if (observed.managed) {
      const context = observed.context;
      if (
        !context || context.closed || !pids.includes(context.pid) ||
        context.operationId !== owner.operationId ||
        context.primaryThreadId !== threadId ||
        context.displayedThreadId !== threadId
      ) return null;
      if (context.displayedRunning) return "agent_running";
      return context.inputReady ? "agent_idle" : null;
    }
    const expected = [...codexScheduledArgs(config), "resume", threadId];
    for (const pid of pids) {
      const args = await readCodexProcessArguments(pid);
      if (!args) continue;
      // These launch-only overrides may be absent on terminals created by older Backends.
      const actual = args.filter(
        (arg, index) =>
          !(
            ((arg === "-c" || arg === "--config") &&
              [
                "check_for_update_on_startup=false",
                'tui.resume_cwd="current"',
              ].includes(args[index + 1] ?? "")) ||
            (index > 0 &&
              (args[index - 1] === "-c" || args[index - 1] === "--config") &&
              [
                "check_for_update_on_startup=false",
                'tui.resume_cwd="current"',
              ].includes(arg))
          ),
      );
      if (JSON.stringify(actual) !== JSON.stringify(expected)) continue;
      if (await ownsResumeHistory(pid, checkpoint, cwd)) {
        return owner.panel.terminalState?.state === "agent_running"
          ? "agent_running" : "agent_idle";
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function ownsResumeHistory(
  pid: number,
  checkpoint: ResumeCheckpoint,
  cwd: string,
): Promise<boolean> {
  if (process.platform === "linux") {
    if ((await readlink(`/proc/${pid}/cwd`)) !== cwd) return false;
    const histories: Array<{ ino: number; dev: number }> = [];
    for (const fd of await readdir(`/proc/${pid}/fd`)) {
      const file = `/proc/${pid}/fd/${fd}`;
      const name = await readlink(file).catch(() => "");
      if (!/\/rollout-[^/]+\.jsonl$/.test(name)) continue;
      const flags = (await readFile(`/proc/${pid}/fdinfo/${fd}`, "utf8")).match(
        /^flags:\s+([0-7]+)/m,
      );
      if (flags && (parseInt(flags[1]!, 8) & 3) !== 0)
        histories.push(await stat(file));
    }
    return histories.some(
      (file) => file.ino === checkpoint.inode && file.dev === checkpoint.device,
    );
  }
  if (process.platform !== "darwin") return false;
  const { stdout } = await exec(
    "/usr/sbin/lsof",
    ["-nP", "-a", "-p", String(pid), "-FfatDin"],
    { timeout: 3000, maxBuffer: 4 * 1024 * 1024 },
  );
  const files = stdout
    .split("\nf")
    .slice(1)
    .map((entry) => {
      const fields = entry.split("\n");
      const value = (prefix: string) =>
        fields.find((field) => field.startsWith(prefix))?.slice(1);
      return {
        fd: fields[0],
        access: value("a"),
        type: value("t"),
        device: Number(value("D")),
        inode: Number(value("i")),
        name: value("n"),
      };
    });
  if (!files.some((file) => file.fd === "cwd" && file.name === cwd))
    return false;
  const histories = files.filter(
    (file) =>
      file.type === "REG" &&
      ["w", "u"].includes(file.access ?? "") &&
      /\/rollout-[^/]+\.jsonl$/.test(file.name ?? ""),
  );
  return histories.some(
    (file) => file.inode === checkpoint.inode && file.device === checkpoint.device,
  );
}
