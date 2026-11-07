import { execFileSync } from "node:child_process";
import { closeSync, fsyncSync, openSync } from "node:fs";

/** Keep PID reuse protection on both Windows and POSIX. */
export function processStartIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    return execFileSync(process.platform === "win32" ? "powershell.exe" : "ps",
      process.platform === "win32"
        ? ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`]
        : ["-p", String(pid), "-o", "lstart="],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, windowsHide: true },
    ).trim() || null;
  } catch { return null; }
}

/** Windows cannot open directories through fs.open; file fsync still precedes rename. */
export function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
