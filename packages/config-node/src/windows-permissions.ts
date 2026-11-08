import { execFileSync } from "node:child_process";
import { ConfigurationError } from "./errors";

/** POSIX mode bits do not express Windows privacy. Check the actual DACL instead. */
export function assertWindowsPrivatePath(file: string): void {
  if (process.platform !== "win32") return;
  const script = `
$ErrorActionPreference = 'Stop'
# Use .NET directly: a parent pwsh may export a PSModulePath incompatible with Windows PowerShell.
$acl = if ([IO.Directory]::Exists($env:RUNWEAVE_PRIVATE_PATH)) {
  [IO.Directory]::GetAccessControl($env:RUNWEAVE_PRIVATE_PATH)
} else { [IO.File]::GetAccessControl($env:RUNWEAVE_PRIVATE_PATH) }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$allowed = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $allowed) { throw 'owner' }
foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $allowed) { throw 'access' }
}
`;
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      env: { ...process.env, RUNWEAVE_PRIVATE_PATH: file }, stdio: "ignore", timeout: 10_000, windowsHide: true,
    });
  } catch { throw new ConfigurationError("CONFIG_WINDOWS_ACL_NOT_PRIVATE", [file]); }
}
