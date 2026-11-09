import { execFileSync } from "node:child_process";

/** SQLite shares its files on Windows; FileShare.None rejects even idle open connections. */
export function assertWindowsDatabaseOffline(databasePath: string): void {
  const script = `
$ErrorActionPreference = 'Stop'
$handles = [System.Collections.Generic.List[System.IDisposable]]::new()
try {
  $database = $env:RUNWEAVE_MIGRATION_DATABASE_PATH
  foreach ($file in @($database, ($database + '-wal'), ($database + '-shm'))) {
    try {
      $handles.Add([System.IO.File]::Open($file, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None))
    } catch {
      $cause = $_.Exception.GetBaseException()
      if ($cause -isnot [System.IO.FileNotFoundException]) { throw }
      if ($file -eq $database) { throw }
    }
  }
} finally {
  foreach ($handle in $handles) { $handle.Dispose() }
}
`;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    env: { ...process.env, RUNWEAVE_MIGRATION_DATABASE_PATH: databasePath },
    stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
  });
}
