import { execFile } from "node:child_process";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { TerminalWorktreeCleanupWarning } from "@runweave/shared/terminal/project-context";

const execFileAsync = promisify(execFile);
const CLEANUP_TIMEOUT_MS = 30_000;

interface DevSessionManifest {
  devSessionId?: string;
  state?: string;
  source?: { root?: string };
  failure?: { leaseRetained?: boolean };
  services?: { backend?: { pid?: number; process?: { pid?: number } } };
}

function isReleased(manifest: DevSessionManifest): boolean {
  return (
    manifest.state === "stopped" ||
    (manifest.state === "failed" && manifest.failure?.leaseRetained === false)
  );
}

function cleanupFailureMessage(error: unknown): string {
  const stderr = (error as { stderr?: string })?.stderr;
  if (stderr) {
    try {
      const payload = JSON.parse(stderr) as { error?: string };
      if (typeof payload.error === "string") {
        return /identity|ownership/i.test(payload.error)
          ? "服务归属无法确认，未完成清理"
          : "服务停止失败，详情见该 Session 的记录";
      }
    } catch {
      // Use a readable fallback without exposing raw command output.
    }
  }
  return "未能完成 Dev Session 清理，可查看该 Session 的记录";
}

/** Cleanup is best effort; only Git/path/data checks gate Worktree removal. */
export async function cleanupWorktreeDevSessions(
  sourceRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<TerminalWorktreeCleanupWarning[]> {
  const registryRoot = path.resolve(
    env.RUNWEAVE_DEV_SESSION_HOME?.trim() ||
      path.join(os.homedir(), ".runweave", "dev-sessions"),
  );
  let entries;
  try {
    entries = await readdir(registryRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [{ devSessionId: null, message: "无法读取 Dev Session 记录" }];
  }
  const sessions: Array<{
    id: string;
    manifestPath: string;
    manifest: DevSessionManifest;
  }> = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(registryRoot, entry.name, "manifest.json");
    try {
      const stats = await lstat(manifestPath);
      if (!stats.isFile() || stats.isSymbolicLink()) continue;
      const manifest = JSON.parse(
        await readFile(manifestPath, "utf8"),
      ) as DevSessionManifest;
      if (typeof manifest.source?.root !== "string" || isReleased(manifest))
        continue;
      const root = await realpath(manifest.source.root).catch(() => null);
      if (root !== sourceRoot) continue;
      sessions.push({ id: entry.name, manifestPath, manifest });
    } catch {
      // An unreadable manifest cannot establish ownership of this Worktree.
    }
  }
  // Independent Sessions share one time budget, rather than multiplying waits.
  const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
  const results = await Promise.all(
    sessions.map(async ({ id, manifestPath, manifest }) => {
      const warning = (message: string): TerminalWorktreeCleanupWarning => ({
        devSessionId: id,
        message,
      });
      if (
        manifest.devSessionId !== id ||
        !/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(id)
      ) {
        return warning("Session 身份信息不一致，未停止服务");
      }
      if (
        env.RUNWEAVE_DEV_SESSION_ID === id ||
        manifest.services?.backend?.pid === process.pid ||
        manifest.services?.backend?.process?.pid === process.pid
      ) {
        return warning("当前请求由该 Session 处理，未停止其 Backend");
      }
      const stop = async (cleanupStale: boolean) => {
        const timeout = deadline - Date.now();
        if (timeout <= 0) throw new Error("Dev Session 清理超时");
        const { stdout } = await execFileAsync(
          process.execPath,
          [
            path.join(sourceRoot, "scripts", "dev-session", "cli.mjs"),
            "stop",
            "--session",
            id,
            ...(cleanupStale ? ["--cleanup-stale"] : []),
            "--json",
          ],
          {
            cwd: sourceRoot,
            env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
            timeout,
            // The deadline terminates our cleanup CLI, not unverified services.
            killSignal: "SIGKILL",
            maxBuffer: 1024 * 1024,
          },
        );
        if (!isReleased(JSON.parse(stdout) as DevSessionManifest)) {
          throw new Error("Dev Session 尚未确认释放资源");
        }
      };
      try {
        try {
          await stop(manifest.state === "stale");
        } catch (error) {
          // Normal stop can discover drift; retry its explicit stale recovery once.
          const current = JSON.parse(
            await readFile(manifestPath, "utf8"),
          ) as DevSessionManifest;
          if (
            manifest.state === "stale" ||
            current.state !== "stale" ||
            current.devSessionId !== id ||
            current.source?.root !== manifest.source?.root
          )
            throw error;
          await stop(true);
        }
        return null;
      } catch (error) {
        return warning(
          Date.now() >= deadline
            ? "Dev Session 清理超时"
            : cleanupFailureMessage(error),
        );
      }
    }),
  );
  return results.filter(
    (result): result is TerminalWorktreeCleanupWarning => result !== null,
  );
}
