import { execFile, execFileSync } from "node:child_process";
import { closeSync, fsyncSync, openSync } from "node:fs";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

/** Keep PID reuse protection on both Windows and POSIX. */
export function processStartIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    return execFileSync(process.platform === "win32" ? "powershell.exe" : "ps",
      process.platform === "win32"
        ? ["-NoProfile", "-NonInteractive", "-Command", `[Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks`]
        : ["-p", String(pid), "-o", "lstart="],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, windowsHide: true },
    ).trim() || null;
  } catch { return null; }
}

/** The same PID-reuse check without blocking IPC readers and request deadlines. */
export async function processStartIdentityAsync(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const { stdout } = await executeFile(process.platform === "win32" ? "powershell.exe" : "ps",
      process.platform === "win32"
        ? ["-NoProfile", "-NonInteractive", "-Command", `[Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks`]
        : ["-p", String(pid), "-o", "lstart="],
      { encoding: "utf8", timeout: 5000, windowsHide: true },
    );
    return stdout.trim() || null;
  } catch { return null; }
}

/** Windows cannot open directories through fs.open; file fsync still precedes rename. */
export function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
