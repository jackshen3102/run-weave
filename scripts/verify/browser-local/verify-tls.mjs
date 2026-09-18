import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const directory = mkdtempSync(path.join(tmpdir(), "runweave-local-tls-"));
try {
  for (const name of ["trusted", "untrusted"]) {
    const result = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost",
        "-keyout",
        path.join(directory, name + ".key"),
        "-out",
        path.join(directory, name + ".crt"),
      ],
      { stdio: "ignore" },
    );
    if (result.status !== 0)
      throw new Error("Cannot generate isolated TLS fixture");
  }
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      "@runweave/backend",
      "exec",
      "tsx",
      "../scripts/verify/browser-local/verify.mts",
    ],
    {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      stdio: "inherit",
      env: {
        ...process.env,
        LOCAL_BROWSER_TLS_DIR: directory,
        NODE_EXTRA_CA_CERTS: path.join(directory, "trusted.crt"),
      },
    },
  );
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
