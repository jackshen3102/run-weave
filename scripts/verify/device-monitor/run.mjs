import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
const directory = mkdtempSync(path.join(tmpdir(), "runweave-battery-tls-"));
try {
  const cert = path.join(directory, "cert.pem"),
    key = path.join(directory, "key.pem");
  const generated = spawnSync(
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
      key,
      "-out",
      cert,
    ],
    { stdio: "ignore" },
  );
  if (generated.status !== 0)
    throw new Error("Could not create isolated TLS fixture");
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      "@runweave/backend",
      "exec",
      "tsx",
      path.resolve("scripts/verify/device-monitor/index.ts"),
      ...process.argv.slice(2),
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        NODE_EXTRA_CA_CERTS: cert,
        BATTERY_FIXTURE_CERT: cert,
        BATTERY_FIXTURE_KEY: key,
      },
    },
  );
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
