import { spawn } from "node:child_process";
import { appendFileSync, existsSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { readResearchMcpInstallation, researchMcpHome } from "@runweave/config-node";

/** launchd owns this foreground runner; it never starts a second background manager. */
export async function runManagedTunnel(): Promise<void> {
  const installation = readResearchMcpInstallation();
  if (!installation?.enabled || !installation.tunnel) throw new Error("Research tunnel is not enabled/configured");
  const deadline = Date.now() + 60_000;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${installation.port}/health`, { signal: AbortSignal.timeout(1000) });
      const health = await response.json() as { service?: string; instance?: string; releaseId?: string };
      ready = response.ok && health.service === "runweave-research-mcp" && health.instance === installation.instanceId && health.releaseId === installation.releaseId;
    } catch { /* MCP starts independently; wait for its real identity. */ }
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error("MCP startup timed out; launchd will retry tunnel startup");
  const log = path.join(researchMcpHome(), "logs", "tunnel-runtime.log");
  const write = (chunk: Buffer) => {
    if (existsSync(log) && statSync(log).size + chunk.length > 5 * 1024 * 1024) {
      rmSync(`${log}.3`, { force: true });
      for (let i = 2; i >= 1; i--) if (existsSync(`${log}.${i}`)) renameSync(`${log}.${i}`, `${log}.${i + 1}`);
      renameSync(log, `${log}.1`);
    }
    appendFileSync(log, chunk, { mode: 0o600 });
  };
  const child = spawn(installation.tunnel.executable, ["run", "--profile-dir", installation.tunnel.profileDir, "--profile", installation.tunnel.profile], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", write);
  child.stderr.on("data", write);
  console.log(JSON.stringify({ event: "tunnel.started", time: new Date().toISOString(), pid: child.pid }));
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    child.kill("SIGTERM");
    timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        console.log(JSON.stringify({ event: "tunnel.closed", time: new Date().toISOString(), code, signal }));
        process.exitCode = stopping ? 0 : code ?? 1;
        resolve();
      });
    });
  } finally {
    if (timer) clearTimeout(timer);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
