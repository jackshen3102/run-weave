import { spawn } from "node:child_process";
import { existsSync, openSync, closeSync } from "node:fs";
import path from "node:path";
import type { EnvironmentContext } from "@runweave/shared/configuration";
import { processStartIdentity } from "@runweave/config-node";
import { PtyHostClient } from "./client";
import { hostPaths, prepareHostDirectory, readHost, recordedHostPid, writeHostJson } from "./discovery";

/** Only the outer manager starts a Host. Backend reconnection never starts a substitute. */
export async function ensureHost(scope: EnvironmentContext, release: string): Promise<void> {
  const paths = prepareHostDirectory(scope);
  if (existsSync(paths.descriptor)) {
    try {
      readHost(scope);
      const client = await PtyHostClient.connect(scope);
      client.close();
      return;
    } catch (error) {
      const pid = recordedHostPid(scope);
      if (!pid || processStartIdentity(pid)) throw error;
    }
  }
  const entry = path.join(release, "pty-host/index.cjs");
  if (!existsSync(entry)) throw new Error("HOST_PAYLOAD_MISSING");
  writeHostJson(paths.launch, { scope, release });
  const log = openSync(path.join(paths.root, "host.log"), "a", 0o600);
  try {
    const child = spawn(process.execPath, [entry, "--root", paths.root], {
      detached: true, windowsHide: true, stdio: ["ignore", log, log],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined },
    });
    child.on("error", () => {});
    child.unref();
  } finally { closeSync(log); }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { const client = await PtyHostClient.connect(scope); client.close(); return; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  throw new Error("HOST_START_TIMEOUT");
}
export { hostPaths, readHost };
