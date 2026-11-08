import { execFileSync } from "node:child_process";
import type { BackendProfileLockOwner } from "@runweave/shared/browser-profile-node";

/** Windows can retain a terminated process object; kill(pid, 0) alone is insufficient. */
export function isWindowsProfileOwnerLive(owner: BackendProfileLockOwner): boolean {
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) return true;
  const script = `$ErrorActionPreference='Stop'; try { $p=[Diagnostics.Process]::GetProcessById(${owner.pid}) } catch [ArgumentException] { 'exited'; exit 0 }; if ($p.HasExited) { 'exited' } else { $p.StartTime.ToUniversalTime().Ticks }`;
  try {
    const identity = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, windowsHide: true,
    }).trim();
    if (identity === "exited") return false;
    if (owner.processStartedAt && /^\d+$/.test(identity)) return identity === owner.processStartedAt;
  } catch { /* A probe failure cannot authorize removing a live or legacy lock. */ }
  return true;
}
