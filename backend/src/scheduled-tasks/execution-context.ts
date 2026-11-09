import { constants } from "node:fs";
import { access, lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { ScheduledExecutionContext, ScheduledRun } from "@runweave/shared/scheduled-tasks";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import { ScheduledTaskError } from "./errors";

export function taskWorkspace(databasePath: string, runId: string): ScheduledExecutionContext {
  return { kind: "task-workspace", cwd: path.join(path.dirname(databasePath), "workspaces", runId) };
}

export async function validateExecutionContext(
  run: ScheduledRun,
  manager: TerminalSessionManager,
  firstStart = false,
): Promise<string> {
  const context = run.executionContext;
  if (context.kind === "unavailable") throw new ScheduledTaskError("context_unavailable", 409, "原执行目录未保存，无法恢复。");
  if (context.kind === "project" && run.snapshot.origin?.kind === "quick-input" &&
      manager.getProject(context.projectId)?.path !== context.cwd) {
    throw new ScheduledTaskError("context_unavailable", 409, "原项目或 Worktree 执行位置已变化。");
  }
  if (context.kind === "task-workspace") {
    const root = path.dirname(context.cwd);
    if (!path.isAbsolute(context.cwd) || path.basename(root) !== "workspaces" || path.basename(context.cwd) !== run.id)
      throw new ScheduledTaskError("workspace_unavailable", 409, "任务工作目录归属无效。");
    try {
      if (firstStart) {
        await mkdir(root, { recursive: true, mode: 0o700 });
        await mkdir(context.cwd, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      }
      const [rootInfo, info, canonicalRoot, canonicalCwd] = await Promise.all([
        lstat(root), lstat(context.cwd), realpath(root), realpath(context.cwd),
      ]);
      if (!rootInfo.isDirectory() || !info.isDirectory() || rootInfo.isSymbolicLink() || info.isSymbolicLink() ||
          canonicalCwd !== path.join(canonicalRoot, run.id) || ((info.mode | rootInfo.mode) & 0o077) !== 0 ||
          (typeof process.getuid === "function" && (info.uid !== process.getuid() || rootInfo.uid !== process.getuid()))) throw new Error("invalid workspace");
      await access(context.cwd, constants.R_OK | constants.W_OK | constants.X_OK);
    } catch {
      throw new ScheduledTaskError("workspace_unavailable", 409, "本次运行的私有工作目录不可用；不会改用其他目录或重建恢复现场。");
    }
  } else {
    if (!(await lstat(context.cwd).catch(() => null))?.isDirectory())
      throw new ScheduledTaskError("context_unavailable", 409, "原执行目录不可用。");
  }
  return context.cwd;
}
