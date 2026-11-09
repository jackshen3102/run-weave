import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { readJson, verifyRelease, type ServerContext } from "./context.js";

export async function runServerToolkit(
  ctx: ServerContext,
  positionals: string[],
  dryRun: boolean,
  stderr: Pick<NodeJS.WriteStream, "write">,
) {
  const action = positionals[0];
  if (positionals.length !== 1 || !["install", "update"].includes(action ?? ""))
    throw new Error("Usage: rw server toolkit <install|update> [--dry-run] [--json]");
  const entry = path.join(ctx.release, "scripts/toolkit/sync.mjs");
  const metadata = path.join(ctx.release, "plugins/toolkit-release.json");
  if (!existsSync(entry) || !existsSync(metadata))
    throw new Error("TOOLKIT_NOT_PACKAGED: update the Server to a release that includes Toolkit");
  verifyRelease(ctx.release);
  const release = readJson<{ version: string; digest: string }>(metadata);
  if (!dryRun) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [entry, "--packaged"], {
        cwd: ctx.release,
        stdio: ["ignore", "pipe", "pipe"],
        // An explicitly requested install must not be skipped by a source commit-hook flag.
        env: { ...process.env, RUNWEAVE_SKIP_TOOLKIT_PLUGIN_SYNC: "0" },
      });
      child.stdout.on("data", (data: Buffer) => stderr.write(data));
      child.stderr.on("data", (data: Buffer) => stderr.write(data));
      child.on("error", reject);
      child.on("exit", code => code === 0 ? resolve() : reject(new Error(`Toolkit ${action} failed (exit ${code}); see installer diagnostics`)));
    });
  }
  return {
    action, dryRun, serverVersion: ctx.manifest.version,
    toolkitVersion: release.version, digest: release.digest,
    guidance: dryRun ? "No Agent installation changed" : "Open a new Agent session to load updated skills; see installer diagnostics for skipped Agents",
  };
}
