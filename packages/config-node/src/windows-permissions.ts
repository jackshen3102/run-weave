import { execFileSync } from "node:child_process";
import { ConfigurationError } from "./errors";

/** POSIX mode bits do not express Windows privacy. Check the actual DACL instead. */
export function assertWindowsPrivatePath(file: string): void {
  if (process.platform !== "win32") return;
  const script = `
$ErrorActionPreference = 'Stop'
try {
# Use .NET directly: a parent pwsh may export a PSModulePath incompatible with Windows PowerShell.
$acl = if ([IO.Directory]::Exists($env:RUNWEAVE_PRIVATE_PATH)) {
  [IO.Directory]::GetAccessControl($env:RUNWEAVE_PRIVATE_PATH)
} else { [IO.File]::GetAccessControl($env:RUNWEAVE_PRIVATE_PATH) }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$allowed = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $allowed) { [Console]::Write('owner'); exit 0 }
foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $allowed) { [Console]::Write('access'); exit 0 }
}
[Console]::Write('private')
} catch {
  [Console]::Write('check-failed:' + $_.Exception.GetType().FullName + ':' + $_.Exception.HResult)
}
`;
  const startedAt = performance.now();
  let result: string;
  try {
    result = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      env: { ...process.env, RUNWEAVE_PRIVATE_PATH: file }, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
      maxBuffer: 64 * 1024, timeout: 10_000, windowsHide: true,
    }).trim();
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException & { status?: number; signal?: string };
    // Do not embed execFileSync's message: it contains the command and raw stderr.
    throw new ConfigurationError(error.code === "ETIMEDOUT" ? "CONFIG_WINDOWS_ACL_CHECK_TIMEOUT" : "CONFIG_WINDOWS_ACL_CHECK_FAILED",
      [file, `exit=${error.status ?? "none"}`, `signal=${error.signal ?? "none"}`, `code=${error.code ?? "none"}`,
        `elapsedMs=${Math.round(performance.now() - startedAt)}`]);
  }
  if (result === "owner" || result === "access") throw new ConfigurationError("CONFIG_WINDOWS_ACL_NOT_PRIVATE", [file, result]);
  if (/^check-failed:[A-Za-z0-9_.]+:-?\d+$/.test(result)) throw new ConfigurationError("CONFIG_WINDOWS_ACL_CHECK_FAILED", [file, result]);
  if (result !== "private") throw new ConfigurationError("CONFIG_WINDOWS_ACL_CHECK_FAILED", [file, "invalid-result"]);
}
